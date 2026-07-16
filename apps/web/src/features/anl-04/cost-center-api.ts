import {
  CostBudgetResponseSchema,
  CostReportResponseSchema,
  ReconciliationResponseSchema,
  type CostFilters,
  type ProviderStatementLine,
} from './cost-center.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function loadCostReport(filters: CostFilters, signal?: AbortSignal) {
  return (
    await request(
      `/api/v1/analytics/costs?${costQuery(filters)}`,
      CostReportResponseSchema,
      { method: 'GET' },
      signal,
    )
  ).data;
}

export async function loadCostBudget(workspaceId: string, month: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ month, workspace_id: workspaceId });
  return (
    await request(
      `/api/v1/analytics/costs/budget?${query}`,
      CostBudgetResponseSchema,
      { method: 'GET' },
      signal,
    )
  ).data;
}

export async function reconcileProviderStatement(
  filters: CostFilters,
  statementLines: readonly ProviderStatementLine[],
  csrf: string,
) {
  const response = await request(
    '/api/v1/analytics/costs/reconcile',
    ReconciliationResponseSchema,
    {
      body: JSON.stringify({
        ...Object.fromEntries(costQuery(filters)),
        statement_lines: statementLines,
      }),
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      method: 'POST',
    },
  );
  return response.data;
}

function costQuery(filters: CostFilters) {
  const query = new URLSearchParams({
    from: filters.from,
    to: filters.to,
    workspace_id: filters.workspaceId,
  });
  if (filters.currency) query.set('currency', filters.currency);
  if (filters.packageId) query.set('package_id', filters.packageId);
  if (filters.projectId) query.set('project_id', filters.projectId);
  return query;
}

async function request<T>(
  path: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  init: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    ...init,
    credentials: 'include',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new CostCenterRequestError(response.status);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new CostCenterRequestError(502);
  return parsed.data;
}

export class CostCenterRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Cost center request failed');
    this.name = 'CostCenterRequestError';
  }
}
