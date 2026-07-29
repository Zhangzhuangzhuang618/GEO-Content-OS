import { apiGet } from '@/lib/api-fetch';
import { createRequestUuid } from '@/lib/request-uuid';

import {
  ContentPackagePageSchema,
  ContentPackageResponseSchema,
  CostBreakdownResponseSchema,
  type ContentPackage,
  type PackageFilters,
  type PackageListItem,
} from './content-package-list.schema';
import { getAccountSession } from '../app-shell/account-api';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function listContentPackages(
  filters: PackageFilters,
  canReadCosts: boolean,
  signal?: AbortSignal,
): Promise<{ readonly items: PackageListItem[]; readonly nextCursor: string | null }> {
  const query = new URLSearchParams({ limit: '10' });
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

  const costs = canReadCosts ? await loadOptionalCosts(signal) : null;

  return {
    items: page.data.data.map((item) => {
      const { brief_title: briefTitle, variants, ...contentPackage } = item;
      return {
        briefTitle,
        costs:
          costs === null
            ? null
            : costs
                ?.filter((cost) => cost.package_id === item.id)
                .map((cost) => ({
                  costCents: cost.cost_cents,
                  currency: cost.currency,
                })),
        detailState: 'ready' as const,
        package: contentPackage,
        variants,
      };
    }),
    nextCursor: page.data.meta.next_cursor,
  };
}

async function loadOptionalCosts(signal?: AbortSignal) {
  try {
    return await loadSettledCosts(signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}

export async function loadCurrentUserId(signal?: AbortSignal): Promise<string> {
  return (await getAccountSession(signal)).user.id;
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
      'idempotency-key': `content-package-copy-${createRequestUuid()}`,
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
  const response = await apiGet(`${API_ORIGIN}${path}`, { signal });
  if (!response.ok) {
    throw new ContentPackageListRequestError(
      response.status,
      parseRetryAfter(response.headers.get('Retry-After')),
    );
  }
  return response;
}

export class ContentPackageListRequestError extends Error {
  public constructor(
    public readonly status: number,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super('Content package list request failed');
    this.name = 'ContentPackageListRequestError';
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}
