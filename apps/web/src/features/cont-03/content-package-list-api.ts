import {
  ContentPackageDetailResponseSchema,
  ContentPackagePageSchema,
  ContentPackageResponseSchema,
  CostBreakdownResponseSchema,
  type ContentPackage,
  type PackageFilters,
  type PackageListItem,
} from './content-package-list.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function listContentPackages(
  filters: PackageFilters,
  canReadCosts: boolean,
  signal?: AbortSignal,
): Promise<{ readonly items: PackageListItem[]; readonly nextCursor: string | null }> {
  const query = new URLSearchParams({ limit: '20' });
  if (filters.createdBy) query.set('created_by', filters.createdBy);
  if (filters.cursor) query.set('cursor', filters.cursor);
  if (filters.platformCode) query.set('platform_code', filters.platformCode);
  if (filters.projectId) query.set('project_id', filters.projectId);
  if (filters.status) query.set('status', filters.status);
  if (filters.workspaceId) query.set('workspace_id', filters.workspaceId);

  const pageResponse = await request(`/api/v1/content-packages?${query}`, signal);
  const page = ContentPackagePageSchema.safeParse(await pageResponse.json());
  if (!page.success) throw new ContentPackageListRequestError(502);
  if (page.data.data.length === 0) {
    return { items: [], nextCursor: page.data.meta.next_cursor };
  }

  const [details, costs] = await Promise.all([
    Promise.all(
      page.data.data.map(async (item) => {
        const response = await request(`/api/v1/content-packages/${item.id}`, signal);
        const parsed = ContentPackageDetailResponseSchema.safeParse(await response.json());
        if (!parsed.success) throw new ContentPackageListRequestError(502);
        return parsed.data.data;
      }),
    ),
    canReadCosts ? loadSettledCosts(signal) : Promise.resolve(null),
  ]);

  return {
    items: details.map((detail) => ({
      costs:
        costs === null
          ? null
          : costs
              .filter((cost) => cost.package_id === detail.package.id)
              .map((cost) => ({ costCents: cost.cost_cents, currency: cost.currency })),
      package: detail.package,
      variants: detail.variants,
    })),
    nextCursor: page.data.meta.next_cursor,
  };
}

export async function copyContentPackage(item: ContentPackage, csrf: string) {
  const response = await fetch(`${API_ORIGIN}/api/v1/content-packages`, {
    body: JSON.stringify({
      brief_id: item.brief_id,
      project_id: item.project_id,
      workspace_id: item.workspace_id,
    }),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `content-package-copy-${crypto.randomUUID()}`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  if (!response.ok) throw new ContentPackageListRequestError(response.status);
  const parsed = ContentPackageResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new ContentPackageListRequestError(502);
  return parsed.data.data;
}

async function loadSettledCosts(signal?: AbortSignal) {
  const query = new URLSearchParams({
    from: '1970-01-01',
    to: new Date().toISOString().slice(0, 10),
  });
  const response = await request(`/api/v1/analytics/costs?${query}`, signal);
  const parsed = CostBreakdownResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new ContentPackageListRequestError(502);
  return parsed.data.data.package_totals;
}

async function request(path: string, signal?: AbortSignal) {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new ContentPackageListRequestError(response.status);
  return response;
}

export class ContentPackageListRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Content package list request failed');
    this.name = 'ContentPackageListRequestError';
  }
}
