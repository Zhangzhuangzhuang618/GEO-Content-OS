import {
  SessionResponseSchema,
  SupportGrantResponseSchema,
  TenantPageResponseSchema,
  TenantResponseSchema,
  type PlatformTenant,
  type TenantFilters,
} from './platform-tenant.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function loadPlatformTenants(filters: TenantFilters, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: '100' });
  if (filters.search) query.set('search', filters.search);
  if (filters.status) query.set('status', filters.status);
  if (filters.plan) query.set('plan_code', filters.plan);
  const response = await read(
    `/api/v1/platform/tenants?${query}`,
    TenantPageResponseSchema,
    signal,
  );
  return response.data;
}

export async function loadCurrentUser(signal?: AbortSignal) {
  const response = await read('/api/v1/auth/session', SessionResponseSchema, signal);
  return response.data.user;
}

export async function createPlatformTenant(
  input: {
    readonly name: string;
    readonly slug: string;
    readonly planCode: string;
    readonly timezone: string;
    readonly ownerEmail: string;
    readonly ownerDisplayName: string;
    readonly workspaceName: string;
  },
  csrf: string,
) {
  return mutate(
    '/api/v1/platform/tenants',
    {
      default_workspace_name: input.workspaceName.trim(),
      name: input.name.trim(),
      owner_display_name: input.ownerDisplayName.trim(),
      owner_email: input.ownerEmail.trim(),
      plan_code: input.planCode.trim(),
      slug: input.slug.trim(),
      timezone: input.timezone.trim(),
    },
    csrf,
    TenantResponseSchema,
    { idempotency: `tenant-create-${crypto.randomUUID()}` },
  );
}

export async function changeTenantState(
  tenant: PlatformTenant,
  action: 'restore' | 'suspend',
  csrf: string,
  reason?: string,
) {
  return mutate(
    `/api/v1/platform/tenants/${tenant.id}/${action}`,
    action === 'suspend' ? { reason: reason?.trim() } : undefined,
    csrf,
    TenantResponseSchema,
    { version: tenant.version },
  );
}

export async function createSupportGrant(
  input: {
    readonly hours: number;
    readonly platformUserId: string;
    readonly reason: string;
    readonly tenantId: string;
  },
  csrf: string,
) {
  const expiresAt = new Date(Date.now() + input.hours * 60 * 60 * 1_000).toISOString();
  return mutate(
    '/api/v1/platform/support-access-grants',
    {
      expires_at: expiresAt,
      platform_user_id: input.platformUserId,
      reason: input.reason.trim(),
      scope: { permissions: ['content.read'], resource_types: ['tenant_content'] },
      tenant_id: input.tenantId,
    },
    csrf,
    SupportGrantResponseSchema,
    { idempotency: `support-grant-${crypto.randomUUID()}` },
  );
}

export class PlatformTenantRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Platform tenant request failed');
    this.name = 'PlatformTenantRequestError';
  }
}

async function read<T>(
  path: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new PlatformTenantRequestError(response.status);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformTenantRequestError(502);
  return parsed.data;
}

async function mutate<T>(
  path: string,
  body: unknown,
  csrf: string,
  schema: {
    safeParse(value: unknown): { success: true; data: { data: T } } | { success: false };
  },
  options: { readonly idempotency?: string; readonly version?: number },
): Promise<T> {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: 'include',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.idempotency ? { 'idempotency-key': options.idempotency } : {}),
      ...(options.version ? { 'if-match': `"${options.version}"` } : {}),
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  if (!response.ok) throw new PlatformTenantRequestError(response.status);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformTenantRequestError(502);
  return parsed.data.data;
}
