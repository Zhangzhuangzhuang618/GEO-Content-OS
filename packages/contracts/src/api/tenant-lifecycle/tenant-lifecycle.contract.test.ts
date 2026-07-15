import { describe, expect, it } from 'vitest';

import {
  TENANT_LIFECYCLE_API_CONTRACTS,
  TENANT_LIFECYCLE_OPENAPI_DOCUMENT,
  TenantExportJobResponseSchema,
} from './index.js';

describe('tenant lifecycle API contract', () => {
  it('freezes both tenant export endpoints and policies', () => {
    expect(TENANT_LIFECYCLE_API_CONTRACTS).toHaveLength(2);
    expect(TENANT_LIFECYCLE_API_CONTRACTS.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /tenant-exports',
      'GET /tenant-exports/{id}',
    ]);
    expect(TENANT_LIFECYCLE_API_CONTRACTS.every((item) => item.policy === 'tenant_owner')).toBe(
      true,
    );
  });

  it('validates the non-secret export job view', () => {
    expect(
      TenantExportJobResponseSchema.safeParse({
        data: {
          created_at: '2026-07-15T00:00:00.000Z',
          error_json: null,
          expires_at: null,
          id: '3e000000-0000-4000-8000-000000000134',
          manifest_hash: null,
          object_uri: null,
          requested_by: '1e000000-0000-4000-8000-000000000134',
          status: 'queued',
          tenant_id: '2e000000-0000-4000-8000-000000000134',
          updated_at: '2026-07-15T00:00:00.000Z',
        },
        meta: { request_id: 'tenant-lifecycle-request' },
      }).success,
    ).toBe(true);
    expect(TENANT_LIFECYCLE_OPENAPI_DOCUMENT.openapi).toBe('3.1.0');
  });
});
