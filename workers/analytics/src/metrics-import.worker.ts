import { createHash } from 'node:crypto';

import { previewMetricsCsv, type MetricImportPreview } from './metrics-import.js';
import {
  MetricsImportWorkerError,
  validateMetricsImportEvent,
  type MetricsImportEvent,
} from './metrics-import.event.js';

export interface MetricsImportLoaderPort {
  load(objectKey: string, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface MetricsImportStorePort {
  claim(event: MetricsImportEvent): Promise<'already_processed' | 'claimed'>;
  complete(event: MetricsImportEvent, preview: MetricImportPreview): Promise<void>;
  fail(event: MetricsImportEvent, message: string): Promise<void>;
}

export interface MetricsImportWorkerResult {
  readonly disposition: 'already_processed' | 'processed';
  readonly errorCount?: number;
  readonly importJobId: string;
  readonly validRowCount?: number;
}

export class MetricsImportWorker {
  public constructor(
    private readonly store: MetricsImportStorePort,
    private readonly loader: MetricsImportLoaderPort,
  ) {}

  public async run(rawEvent: unknown, signal?: AbortSignal): Promise<MetricsImportWorkerResult> {
    const event = validateMetricsImportEvent(rawEvent);
    if ((await this.store.claim(event)) === 'already_processed') {
      return Object.freeze({ disposition: 'already_processed', importJobId: event.importJobId });
    }
    try {
      const body = await this.loader.load(event.objectKey, signal);
      if (createHash('sha256').update(body).digest('hex') !== event.contentHash) {
        throw new MetricsImportWorkerError('Metrics import content hash does not match');
      }
      const csv = new TextDecoder('utf-8', { fatal: true }).decode(body);
      const preview = previewMetricsCsv(csv);
      await this.store.complete(event, preview);
      return Object.freeze({
        disposition: 'processed',
        errorCount: preview.errors.length,
        importJobId: event.importJobId,
        validRowCount: preview.rows.length,
      });
    } catch (error) {
      const normalized =
        error instanceof MetricsImportWorkerError
          ? error
          : new MetricsImportWorkerError('Metrics import failed');
      await this.store.fail(event, normalized.message);
      throw normalized;
    }
  }
}
