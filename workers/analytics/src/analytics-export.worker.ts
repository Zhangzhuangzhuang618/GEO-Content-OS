import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import { createHash } from 'node:crypto';

import {
  AnalyticsExportWorkerError,
  parseAnalyticsExportEvent,
  type AnalyticsExportEvent,
} from './analytics-export.event.js';

export type AnalyticsExportCell = boolean | number | string | null;
export type AnalyticsExportRow = Readonly<Record<string, AnalyticsExportCell>>;

export interface AnalyticsExportStorePort {
  claim(event: AnalyticsExportEvent): Promise<'already_processed' | 'claimed'>;
  complete(
    event: AnalyticsExportEvent,
    result: {
      readonly contentHash: string;
      readonly expiresAt: string;
      readonly objectUri: string;
      readonly rowCount: number;
    },
  ): Promise<void>;
  fail(event: AnalyticsExportEvent, message: string): Promise<void>;
  snapshot(event: AnalyticsExportEvent): Promise<readonly AnalyticsExportRow[]>;
}

export interface AnalyticsExportWorkerResult {
  readonly contentHash?: string;
  readonly disposition: 'already_processed' | 'processed';
  readonly exportJobId: string;
  readonly rowCount?: number;
}

export class AnalyticsExportWorker {
  public constructor(
    private readonly store: AnalyticsExportStorePort,
    private readonly storage: ObjectStorageAdapter,
    private readonly retentionDays = 7,
  ) {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 30) {
      throw new AnalyticsExportWorkerError('Analytics export retention is invalid');
    }
  }

  public async run(value: unknown): Promise<AnalyticsExportWorkerResult> {
    const event = parseAnalyticsExportEvent(value);
    if ((await this.store.claim(event)) === 'already_processed') {
      return Object.freeze({ disposition: 'already_processed', exportJobId: event.exportJobId });
    }
    try {
      const rows = await this.store.snapshot(event);
      const body = new TextEncoder().encode(renderCsv(rows));
      const contentHash = createHash('sha256').update(body).digest('hex');
      const key = `tenants/${event.tenantId}/workspaces/${event.workspaceId}/analytics-exports/${event.exportJobId}.csv`;
      const stored = await this.storage.putObject({
        body,
        contentHash,
        contentType: 'text/csv',
        key,
        metadata: { query_hash: event.queryHash, schema_version: 'analytics-export@1' },
      });
      const expiresAt = new Date(
        new Date(event.occurredAt).getTime() + this.retentionDays * 24 * 60 * 60 * 1_000,
      ).toISOString();
      await this.store.complete(event, {
        contentHash,
        expiresAt,
        objectUri: stored.uri,
        rowCount: rows.length,
      });
      return Object.freeze({
        contentHash,
        disposition: 'processed',
        exportJobId: event.exportJobId,
        rowCount: rows.length,
      });
    } catch (error) {
      const normalized =
        error instanceof AnalyticsExportWorkerError
          ? error
          : new AnalyticsExportWorkerError('Analytics export failed');
      await this.store.fail(event, normalized.message);
      throw normalized;
    }
  }
}

export function renderCsv(rows: readonly AnalyticsExportRow[]): string {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  if (columns.length === 0) return '\uFEFF';
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows)
    lines.push(columns.map((column) => csvCell(row[column] ?? null)).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function csvCell(value: AnalyticsExportCell): string {
  if (value === null) return '';
  const raw = String(value);
  const text = typeof value === 'string' && /^[=+\-@\t\r]/u.test(raw) ? `'${raw}` : raw;
  if (!/[",\r\n]/u.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}
