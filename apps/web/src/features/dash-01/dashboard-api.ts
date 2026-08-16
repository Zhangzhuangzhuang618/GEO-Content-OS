import { createRequestUuid } from '@/lib/request-uuid';

import {
  ContentPackagePageSchema,
  CostBreakdownResponseSchema,
  ProjectPageSchema,
  ProjectResponseSchema,
  type DashboardContentPackage,
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

export async function createProject(
  input: {
    readonly name: string;
    readonly ownerId: string;
    readonly workspaceId: string;
  },
  csrf: string,
): Promise<DashboardProject> {
  const response = await fetch(`${API_ORIGIN}/api/v1/projects`, {
    body: JSON.stringify({
      end_date: null,
      name: input.name.trim(),
      objective: null,
      owner_id: input.ownerId,
      start_date: null,
      workspace_id: input.workspaceId,
    }),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `dashboard-project-create-${createRequestUuid()}`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  if (!response.ok) throw new DashboardRequestError(response.status);
  const parsed = ProjectResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new DashboardRequestError(502);
  return parsed.data.data;
}

export async function listContentPackages(
  filters: DashboardFilters,
  attentionRequired = false,
  signal?: AbortSignal,
): Promise<DashboardContentPackage[]> {
  const contentQuery = new URLSearchParams({ limit: '100', workspace_id: filters.workspaceId });
  if (filters.projectId) contentQuery.set('project_id', filters.projectId);
  if (attentionRequired) contentQuery.set('attention_required', 'true');
  const response = await request(`/api/v1/content-packages?${contentQuery}`, signal);
  const parsed = ContentPackagePageSchema.safeParse(await response.json());
  if (!parsed.success) throw new DashboardRequestError(502);
  return parsed.data.data;
}

export async function loadCostCents(
  filters: DashboardFilters,
  signal?: AbortSignal,
): Promise<number> {
  const costQuery = new URLSearchParams({
    from: filters.from,
    to: filters.to,
    workspace_id: filters.workspaceId,
  });
  if (filters.projectId) costQuery.set('project_id', filters.projectId);
  const response = await request(`/api/v1/analytics/costs?${costQuery}`, signal);
  const parsed = CostBreakdownResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new DashboardRequestError(502);
  return parsed.data.data.totals
    .filter((total) => total.currency === 'CNY')
    .reduce((sum, total) => sum + total.cost_cents, 0);
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
