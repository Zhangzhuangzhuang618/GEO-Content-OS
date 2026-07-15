import {
  ContentPackagePageSchema,
  CostBreakdownResponseSchema,
  ProjectPageSchema,
  type DashboardData,
  type DashboardFilters,
  type DashboardProject,
} from './dashboard.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function listProjects(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<DashboardProject[]> {
  const query = new URLSearchParams({ limit: '100', status: 'active', workspace_id: workspaceId });
  const response = await request(`/api/v1/projects?${query}`, signal);
  const parsed = ProjectPageSchema.safeParse(await response.json());
  if (!parsed.success) throw new DashboardRequestError(502);
  return parsed.data.data;
}

export async function loadDashboardData(
  filters: DashboardFilters,
  canReadCost: boolean,
  signal?: AbortSignal,
): Promise<DashboardData> {
  const contentQuery = new URLSearchParams({ limit: '100', workspace_id: filters.workspaceId });
  if (filters.projectId) contentQuery.set('project_id', filters.projectId);
  const costQuery = new URLSearchParams({
    from: filters.from,
    to: filters.to,
    workspace_id: filters.workspaceId,
  });
  if (filters.projectId) costQuery.set('project_id', filters.projectId);

  const [packagesResponse, costResponse] = await Promise.all([
    request(`/api/v1/content-packages?${contentQuery}`, signal),
    canReadCost ? request(`/api/v1/analytics/costs?${costQuery}`, signal) : Promise.resolve(null),
  ]);
  const packages = ContentPackagePageSchema.safeParse(await packagesResponse.json());
  if (!packages.success) throw new DashboardRequestError(502);
  let costCents: number | null = null;
  if (costResponse) {
    const costs = CostBreakdownResponseSchema.safeParse(await costResponse.json());
    if (!costs.success) throw new DashboardRequestError(502);
    costCents = costs.data.data.totals
      .filter((total) => total.currency === 'CNY')
      .reduce((sum, total) => sum + total.cost_cents, 0);
  }
  return { costCents, packages: packages.data.data };
}

export class DashboardRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Dashboard request failed');
    this.name = 'DashboardRequestError';
  }
}

async function request(path: string, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new DashboardRequestError(response.status);
  return response;
}
