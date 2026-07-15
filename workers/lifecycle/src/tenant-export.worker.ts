import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';

import type { TenantManifestCipher } from './manifest-cipher.js';
import {
  parseTenantExportEvent,
  TenantExportWorkerError,
  type TenantExportEvent,
} from './tenant-export.event.js';

export interface TenantExportSnapshot {
  readonly objectUris: readonly string[];
  readonly rowCounts: Readonly<Record<string, number>>;
}

export interface TenantExportStorePort {
  claim(event: TenantExportEvent): Promise<'already_processed' | 'claimed'>;
  complete(
    event: TenantExportEvent,
    result: { readonly manifestHash: string; readonly objectUri: string },
  ): Promise<void>;
  fail(event: TenantExportEvent, message: string): Promise<void>;
  snapshot(event: TenantExportEvent): Promise<TenantExportSnapshot>;
}

export interface TenantExportWorkerResult {
  readonly disposition: 'already_processed' | 'processed';
  readonly exportJobId: string;
  readonly manifestHash?: string;
}

export class TenantExportWorker {
  public constructor(
    private readonly store: TenantExportStorePort,
    private readonly storage: ObjectStorageAdapter,
    private readonly cipher: TenantManifestCipher,
  ) {}

  public async run(value: unknown): Promise<TenantExportWorkerResult> {
    const event = parseTenantExportEvent(value);
    if ((await this.store.claim(event)) === 'already_processed') {
      return Object.freeze({ disposition: 'already_processed', exportJobId: event.exportJobId });
    }
    try {
      const snapshot = await this.store.snapshot(event);
      const encrypted = this.cipher.encrypt({
        event_id: event.eventId,
        export_job_id: event.exportJobId,
        generated_at: event.occurredAt,
        object_uris: [...snapshot.objectUris].sort(),
        row_counts: Object.fromEntries(Object.entries(snapshot.rowCounts).sort()),
        schema_version: 'tenant-export-manifest@1',
        tenant_id: event.tenantId,
      });
      const key = `tenants/${event.tenantId}/exports/${event.exportJobId}.manifest.enc`;
      const stored = await this.storage.putObject({
        body: encrypted.body,
        contentHash: encrypted.ciphertextHash,
        contentType: 'application/octet-stream',
        key,
        metadata: {
          encrypted: 'true',
          manifest_sha256: encrypted.manifestHash,
          schema_version: 'tenant-export-manifest@1',
        },
      });
      await this.store.complete(event, {
        manifestHash: encrypted.manifestHash,
        objectUri: stored.uri,
      });
      return Object.freeze({
        disposition: 'processed',
        exportJobId: event.exportJobId,
        manifestHash: encrypted.manifestHash,
      });
    } catch (error) {
      const normalized =
        error instanceof TenantExportWorkerError
          ? error
          : new TenantExportWorkerError('Tenant export failed');
      await this.store.fail(event, normalized.message);
      throw normalized;
    }
  }
}
