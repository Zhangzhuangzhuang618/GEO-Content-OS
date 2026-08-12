import { describe, expect, it } from 'vitest';

import {
  CreateTenantRequestSchema,
  PLATFORM_TENANT_API_CONTRACTS,
  PLATFORM_TENANT_OPENAPI_DOCUMENT,
  PlatformTenantResponseSchema,
} from './index.js';

describe('platform tenant API contract', () => {
  it('freezes the platform tenant endpoints including owner invitation resend', () => {
    expect(PLATFORM_TENANT_API_CONTRACTS.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /platform/tenants',
      'GET /platform/tenants',
      'POST /platform/tenants/{id}/suspend',
      'POST /platform/tenants/{id}/restore',
      'POST /platform/tenants/{id}/owner-invitation/resend',
    ]);
    expect(
      Object.values(PLATFORM_TENANT_OPENAPI_DOCUMENT.paths).flatMap((path) => Object.values(path)),
    ).toHaveLength(5);
  });

  it('requires a valid owner and exposes only aggregate platform metadata', () => {
    expect(
      CreateTenantRequestSchema.safeParse({
        name: 'Acme',
        owner_display_name: 'Acme Owner',
        owner_email: 'owner@acme.example',
        slug: 'acme',
      }).success,
    ).toBe(true);
    expect(
      PlatformTenantResponseSchema.safeParse({
        data: {
          created_at: '2026-07-16T00:00:00.000Z',
          health: { checked_at: '2026-07-16T00:00:00.000Z', status: 'healthy' },
          id: '20000000-0000-4000-8000-000000000102',
          name: 'Acme',
          plan_code: 'trial',
          slug: 'acme',
          status: 'active',
          timezone: 'Asia/Shanghai',
          updated_at: '2026-07-16T00:00:00.000Z',
          usage: {
            currency: 'CNY',
            ledger_entries: 0,
            period_end: '2026-08-01T00:00:00.000Z',
            period_start: '2026-07-01T00:00:00.000Z',
            settled_cost_cents: 0,
          },
          version: 1,
        },
        meta: { request_id: 'request-00000001' },
      }).success,
    ).toBe(true);
  });
});
