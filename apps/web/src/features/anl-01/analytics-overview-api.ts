import {
  CostsResponseSchema,
  ExportResponseSchema,
  OverviewResponseSchema,
  PlatformsResponseSchema,
  type AnalyticsFilters,
} from './analytics-overview.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';
export async function loadAnalytics(filters: AnalyticsFilters, signal?: AbortSignal) {
  if (!filters.workspaceId) throw new AnalyticsRequestError(422);
  const query = analyticsQuery(filters);
  const costQuery = new URLSearchParams({
    from: filters.from,
    to: filters.to,
    workspace_id: filters.workspaceId,
  });
  if (filters.projectId) costQuery.set('project_id', filters.projectId);
  const [overview, platforms, costs] = await Promise.all([
    request(`/api/v1/analytics/overview?${query}`, OverviewResponseSchema, signal),
    request(`/api/v1/analytics/platforms?${query}`, PlatformsResponseSchema, signal),
    request(`/api/v1/analytics/costs?${costQuery}`, CostsResponseSchema, signal),
  ]);
  return { costs: costs.data, overview: overview.data, platforms: platforms.data };
}
export async function requestAnalyticsExport(filters: AnalyticsFilters) {
  if (!filters.workspaceId) throw new AnalyticsRequestError(422);
  const query = analyticsQuery(filters);
  query.set('format', 'csv');
  const response = await fetch(`${API_ORIGIN}/api/v1/analytics/export?${query}`, {
    credentials: 'include',
    headers: { 'idempotency-key': `analytics-export-${crypto.randomUUID()}` },
    method: 'GET',
  });
  if (!response.ok) throw new AnalyticsRequestError(response.status);
  const parsed = ExportResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new AnalyticsRequestError(502);
  return parsed.data.data;
}
function analyticsQuery(filters: AnalyticsFilters) {
  const query = new URLSearchParams({
    from: filters.from,
    to: filters.to,
    workspace_id: filters.workspaceId ?? '',
  });
  if (filters.projectId) query.set('project_id', filters.projectId);
  if (filters.platformCodes?.length) query.set('platform_codes', filters.platformCodes.join(','));
  return query;
}
async function request<T>(
  path: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new AnalyticsRequestError(response.status);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new AnalyticsRequestError(502);
  return parsed.data;
}
export class AnalyticsRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Analytics request failed');
    this.name = 'AnalyticsRequestError';
  }
}
