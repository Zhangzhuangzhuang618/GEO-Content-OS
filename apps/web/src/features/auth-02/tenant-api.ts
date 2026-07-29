import { apiGet, invalidateApiGetCache } from '@/lib/api-fetch';
import { createRequestUuid } from '@/lib/request-uuid';

import { TenantChoicesResponseSchema, type TenantChoice } from './tenant.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function listAvailableTenants(signal?: AbortSignal): Promise<TenantChoice[]> {
  const response = await apiGet(`${API_ORIGIN}/api/v1/auth/tenants`, {
    cacheTtlMs: 30_000,
    signal,
  });
  if (!response.ok) throw new TenantRequestError(response.status);

  const parsed = TenantChoicesResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new TenantRequestError(502);
  return parsed.data.data;
}

export async function switchTenant(tenantId: string, csrf: string): Promise<void> {
  const response = await fetch(`${API_ORIGIN}/api/v1/auth/switch-tenant`, {
    body: JSON.stringify({ tenant_id: tenantId }),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `tenant-switch-${createRequestUuid()}`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  if (!response.ok) throw new TenantRequestError(response.status);
  invalidateApiGetCache();
}

export class TenantRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Tenant request failed');
    this.name = 'TenantRequestError';
  }
}
