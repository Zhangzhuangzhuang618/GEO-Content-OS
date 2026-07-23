import { describe, expect, it, vi } from 'vitest';

import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import type { DatabaseClient } from '../../../database/index.js';
import { PublishingApiService } from './publishing-api.service.js';

describe('publishing API serialization', () => {
  it('normalizes PostgreSQL timestamp strings in publish job lists', async () => {
    const client = vi.fn(async () => [
      {
        accountId: 'b1000000-0000-4000-8000-000000000001',
        attemptCount: 0,
        contentVersionId: '3f426902-e9c2-42df-b37e-cb41ccfe979f',
        createdAt: '2026-07-18 08:50:48+00',
        createdBy: '10000000-0000-4000-8000-000000000001',
        externalPostId: null,
        externalUrl: null,
        id: '90000000-0000-4000-8000-000000000001',
        idempotencyKey: 'serialization-test',
        lastError: null,
        origin: 'manual',
        payloadHash: 'a'.repeat(64),
        publishedAt: null,
        scheduledAt: '2026-07-19 01:00:00+00',
        status: 'scheduled',
        tenantId: '20000000-0000-4000-8000-000000000001',
        updatedAt: '2026-07-18 08:51:00+00',
        variantId: 'a8e2c6d3-2e18-4022-ae3a-279da1a87b1d',
        version: 1,
      },
    ]);
    const service = new PublishingApiService(
      client as unknown as DatabaseClient,
      {} as ObjectStorageAdapter,
    );

    const result = await service.listJobs(
      {
        tenantId: '20000000-0000-4000-8000-000000000001',
        userId: '10000000-0000-4000-8000-000000000001',
      },
      { limit: 100 },
    );

    expect(result.items[0]).toMatchObject({
      created_at: '2026-07-18T08:50:48.000Z',
      scheduled_at: '2026-07-19T01:00:00.000Z',
      updated_at: '2026-07-18T08:51:00.000Z',
    });
  });
});
