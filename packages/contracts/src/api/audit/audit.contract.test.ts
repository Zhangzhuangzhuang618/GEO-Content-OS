import { describe, expect, it } from 'vitest';

import {
  AUDIT_API_CONTRACT,
  AUDIT_OPENAPI_DOCUMENT,
  AuditEventPageResponseSchema,
  AuditQuerySchema,
} from './index.js';

describe('audit API contract', () => {
  it('freezes the existing tenant audit endpoint', () => {
    expect(AUDIT_API_CONTRACT).toMatchObject({
      idempotency: '-',
      method: 'GET',
      path: '/audit-events',
      permission: 'audit.read',
      policy: 'tenant_owner',
    });
    expect(AUDIT_OPENAPI_DOCUMENT.openapi).toBe('3.1.0');
    expect(AUDIT_OPENAPI_DOCUMENT.paths['/audit-events'].get).toBeDefined();
  });

  it('validates deterministic filters and an append-only event view', () => {
    expect(
      AuditQuerySchema.safeParse({
        action: 'workspace.updated',
        from: '2026-07-01T00:00:00.000Z',
        limit: '50',
        to: '2026-07-16T23:59:59.999Z',
      }),
    ).toMatchObject({ success: true });
    expect(
      AuditQuerySchema.safeParse({
        from: '2026-07-17T00:00:00.000Z',
        to: '2026-07-16T00:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      AuditEventPageResponseSchema.safeParse({
        data: {
          items: [
            {
              action: 'workspace.updated',
              actor_id: '10000000-0000-4000-8000-000000000100',
              actor_name: 'Owner',
              after: { name: 'New name' },
              before: { name: 'Old name' },
              created_at: '2026-07-16T00:00:00.000Z',
              id: '20000000-0000-4000-8000-000000000100',
              ip: '127.0.0.1',
              request_id: 'req-100',
              resource_id: '30000000-0000-4000-8000-000000000100',
              resource_type: 'workspace',
            },
          ],
          next_cursor: null,
        },
        meta: { request_id: 'request-audit-100' },
      }).success,
    ).toBe(true);
  });
});
