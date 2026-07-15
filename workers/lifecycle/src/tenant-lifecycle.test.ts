import { InMemoryStorageAdapter } from '@geo-content-os/adapter-storage';
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { AesGcmTenantManifestCipher } from './manifest-cipher.js';
import {
  RetentionCleanupWorker,
  type RetentionCleanupCandidate,
  type RetentionCleanupStorePort,
} from './retention-cleanup.worker.js';
import { TenantExportWorker, type TenantExportStorePort } from './tenant-export.worker.js';

const TENANT_ID = '2e000000-0000-4000-8000-000000000134';
const EXPORT_ID = '3e000000-0000-4000-8000-000000000134';

describe('tenant lifecycle worker', () => {
  it('writes an encrypted deterministic-manifest digest and handles replay', async () => {
    const storage = new InMemoryStorageAdapter('lifecycle');
    const complete = vi.fn<TenantExportStorePort['complete']>().mockResolvedValue(undefined);
    const store: TenantExportStorePort = {
      claim: vi.fn().mockResolvedValueOnce('claimed').mockResolvedValueOnce('already_processed'),
      complete,
      fail: vi.fn(),
      snapshot: vi.fn().mockResolvedValue({
        objectUris: ['s3://bucket/tenants/source.txt'],
        rowCounts: { memberships: 2, tenants: 1 },
      }),
    };
    const cipher = new AesGcmTenantManifestCipher(randomBytes(32));
    const worker = new TenantExportWorker(store, storage, cipher);
    const first = await worker.run(event());
    expect(first).toMatchObject({ disposition: 'processed', exportJobId: EXPORT_ID });
    expect(first.manifestHash).toMatch(/^[0-9a-f]{64}$/u);
    const key = `tenants/${TENANT_ID}/exports/${EXPORT_ID}.manifest.enc`;
    const encrypted = storage.readObject(key);
    expect(encrypted).toBeDefined();
    expect(new TextDecoder().decode(encrypted)).not.toContain(TENANT_ID);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ exportJobId: EXPORT_ID }),
      expect.objectContaining({ manifestHash: first.manifestHash }),
    );
    await expect(worker.run(event())).resolves.toEqual({
      disposition: 'already_processed',
      exportJobId: EXPORT_ID,
    });
    cipher.destroy();
  });

  it('supports dry-run and idempotent object cleanup after retention', async () => {
    const storage = new InMemoryStorageAdapter('lifecycle');
    const candidate: RetentionCleanupCandidate = {
      objectUris: ['memory://lifecycle/tenants/a.txt', 'memory://lifecycle/tenants/b.txt'],
      tenantId: TENANT_ID,
    };
    for (const key of ['tenants/a.txt', 'tenants/b.txt']) {
      await storage.putObject({
        body: new TextEncoder().encode(key),
        contentHash: 'a'.repeat(64),
        contentType: 'text/plain',
        key,
      });
    }
    const complete = vi.fn<RetentionCleanupStorePort['complete']>().mockResolvedValue(undefined);
    const store: RetentionCleanupStorePort = {
      complete,
      due: vi.fn().mockResolvedValue([candidate]),
      fail: vi.fn(),
    };
    const worker = new RetentionCleanupWorker(store, storage);
    await expect(
      worker.run({ dryRun: true, now: new Date('2026-07-15T00:00:00Z'), retentionDays: 30 }),
    ).resolves.toEqual({ deletedObjectCount: 0, dryRun: true, tenantCount: 1 });
    expect(storage.readObject('tenants/a.txt')).toBeDefined();
    await expect(
      worker.run({ dryRun: false, now: new Date('2026-07-15T00:00:00Z'), retentionDays: 30 }),
    ).resolves.toEqual({ deletedObjectCount: 2, dryRun: false, tenantCount: 1 });
    expect(storage.readObject('tenants/a.txt')).toBeUndefined();
    expect(complete).toHaveBeenCalledOnce();
  });
});

function event(): unknown {
  return {
    aggregate: { id: EXPORT_ID, type: 'tenant_export_job' },
    data: {
      expires_at: '2026-07-22T00:00:00.000Z',
      tenant_export_job_id: EXPORT_ID,
    },
    event_id: '4e000000-0000-4000-8000-000000000134',
    event_type: 'lifecycle.tenant.export_requested.v1',
    occurred_at: '2026-07-15T00:00:00.000Z',
    tenant: { id: TENANT_ID },
  };
}
