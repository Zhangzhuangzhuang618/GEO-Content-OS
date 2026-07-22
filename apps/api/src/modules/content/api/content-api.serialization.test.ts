import { describe, expect, it, vi } from 'vitest';

import type { IdentityAuthDatabase } from '../../identity/auth/auth.database.js';
import type { OutboxWriter } from '../../outbox/index.js';
import { ContentApiService } from './content-api.service.js';

const PACKAGE_ID = '10000000-0000-4000-8000-000000000001';
const CREATED_AT = '2026-07-16 15:12:34.565052+00';
const UPDATED_AT = '2026-07-16 15:12:34.697493+00';

describe('content package API serialization', () => {
  it('normalizes PostgreSQL timestamp strings in items and pagination cursors', async () => {
    const row = {
      briefId: '10000000-0000-4000-8000-000000000002',
      createdAt: CREATED_AT,
      createdBy: '10000000-0000-4000-8000-000000000003',
      deletedAt: null,
      id: PACKAGE_ID,
      masterContentVersionId: null,
      projectId: '10000000-0000-4000-8000-000000000004',
      status: 'draft',
      tenantId: '10000000-0000-4000-8000-000000000005',
      updatedAt: UPDATED_AT,
      version: 1,
      workspaceId: '10000000-0000-4000-8000-000000000006',
    };
    const client = vi.fn(async () => [row, { ...row, id: '10000000-0000-4000-8000-000000000007' }]);
    const service = new ContentApiService(
      { client } as unknown as IdentityAuthDatabase,
      {} as OutboxWriter,
    );

    const result = await service.listPackages(row.tenantId, row.createdBy, { limit: 1 });

    expect(result.items[0]).toMatchObject({
      created_at: '2026-07-16T15:12:34.565Z',
      updated_at: '2026-07-16T15:12:34.697Z',
    });
    expect(result.nextCursor).not.toBeNull();
    expect(decodeCursor(result.nextCursor!)).toEqual({
      id: PACKAGE_ID,
      updatedAt: '2026-07-16T15:12:34.697Z',
    });
  });

  it('normalizes PostgreSQL timestamp strings throughout package details', async () => {
    const tenantId = '10000000-0000-4000-8000-000000000005';
    const userId = '10000000-0000-4000-8000-000000000003';
    const workspaceId = '10000000-0000-4000-8000-000000000006';
    const projectId = '10000000-0000-4000-8000-000000000004';
    const variantId = '10000000-0000-4000-8000-000000000008';
    const packageRow = {
      briefId: '10000000-0000-4000-8000-000000000002',
      createdAt: CREATED_AT,
      createdBy: userId,
      deletedAt: null,
      id: PACKAGE_ID,
      masterContentVersionId: null,
      projectId,
      status: 'draft',
      tenantId,
      updatedAt: UPDATED_AT,
      version: 1,
      workspaceId,
    };
    const variantRow = {
      createdAt: CREATED_AT,
      currentContentVersionId: null,
      id: variantId,
      isRequired: true,
      packageId: PACKAGE_ID,
      platformCode: 'official_site',
      qualityScore: null,
      status: 'draft',
      tenantId,
      updatedAt: UPDATED_AT,
      version: 1,
    };
    const runRow = {
      createdAt: CREATED_AT,
      error: null,
      finishedAt: null,
      id: '10000000-0000-4000-8000-000000000009',
      inputHash: 'a'.repeat(64),
      modelKey: 'flash',
      packageId: PACKAGE_ID,
      projectId,
      promptVersionId: '10000000-0000-4000-8000-000000000010',
      requestId: 'serialization-test',
      skillName: 'content-writer',
      skillVersion: '1.0.0',
      startedAt: CREATED_AT,
      status: 'running',
      tenantId,
      updatedAt: UPDATED_AT,
      variantId: null,
      version: 1,
      workspaceId,
    };
    const client = vi
      .fn()
      .mockResolvedValueOnce([{ projectId, workspaceId }])
      .mockResolvedValueOnce([packageRow])
      .mockResolvedValueOnce([variantRow])
      .mockResolvedValueOnce([runRow]);
    const service = new ContentApiService(
      { client } as unknown as IdentityAuthDatabase,
      {} as OutboxWriter,
    );

    const result = await service.getPackage(tenantId, userId, PACKAGE_ID);

    expect(result).toMatchObject({
      generation_runs: [
        {
          created_at: '2026-07-16T15:12:34.565Z',
          started_at: '2026-07-16T15:12:34.565Z',
          updated_at: '2026-07-16T15:12:34.697Z',
        },
      ],
      package: {
        created_at: '2026-07-16T15:12:34.565Z',
        updated_at: '2026-07-16T15:12:34.697Z',
      },
      variants: [
        {
          created_at: '2026-07-16T15:12:34.565Z',
          updated_at: '2026-07-16T15:12:34.697Z',
        },
      ],
    });
  });
});

function decodeCursor(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
}
