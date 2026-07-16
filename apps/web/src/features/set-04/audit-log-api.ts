import { AuditPageResponseSchema, type AuditFilters } from './audit-log.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function listAuditEvents(
  filters: AuditFilters,
  cursor?: string,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ limit: '20' });
  if (filters.action) query.set('action', filters.action);
  if (filters.actorId) query.set('actor_id', filters.actorId);
  if (filters.from) query.set('from', `${filters.from}T00:00:00.000Z`);
  if (filters.requestId) query.set('request_id', filters.requestId);
  if (filters.resourceId) query.set('resource_id', filters.resourceId);
  if (filters.resourceType) query.set('resource_type', filters.resourceType);
  if (filters.to) query.set('to', `${filters.to}T23:59:59.999Z`);
  if (cursor) query.set('cursor', cursor);
  const response = await fetch(`${API_ORIGIN}/api/v1/audit-events?${query}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new AuditLogRequestError(response.status);
  const parsed = AuditPageResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new AuditLogRequestError(502);
  return parsed.data.data;
}

export class AuditLogRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Audit log request failed');
    this.name = 'AuditLogRequestError';
  }
}
