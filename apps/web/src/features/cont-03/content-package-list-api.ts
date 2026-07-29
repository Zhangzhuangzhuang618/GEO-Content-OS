import { createRequestUuid } from '@/lib/request-uuid';

import {
  ContentPackageDetailResponseSchema,
  ContentPackagePageSchema,
  ContentPackageResponseSchema,
  CostBreakdownResponseSchema,
  type ContentPackage,
  type PackageFilters,
  type PackageListItem,
} from './content-package-list.schema';
import { BriefEditorRequestError, getBrief } from '../cont-02/brief-editor-api';
import { SessionResponseSchema } from '../plat-01/platform-tenant.schema';

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
    items: page.data.data.map((item) => ({
      briefTitle: fallbackTitle(item.updated_at),
      costs:
        costs === null
          ? null
          : costs
              ?.filter((cost) => cost.package_id === item.id)
              .map((cost) => ({
                costCents: cost.cost_cents,
                currency: cost.currency,
              })),
      detailState: 'loading' as const,
      package: item,
      variants: [],
    })),
    nextCursor: page.data.meta.next_cursor,
  };
}

export async function loadContentPackageListItem(
  item: PackageListItem,
  signal?: AbortSignal,
): Promise<PackageListItem> {
  const response = await request(`/api/v1/content-packages/${item.package.id}`, signal);
  const parsed = ContentPackageDetailResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new ContentPackageListRequestError(502);
  const briefTitle = await loadOptionalBriefTitle(item.package.brief_id, signal);
  return {
    ...item,
    briefTitle: briefTitle ?? fallbackTitle(item.package.updated_at),
    detailState: 'ready',
    package: parsed.data.data.package,
    variants: parsed.data.data.variants,
  };
}

async function loadOptionalBriefTitle(id: string, signal?: AbortSignal) {
  try {
    return await loadBriefTitle(id, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

async function loadOptionalCosts(signal?: AbortSignal) {
  try {
    return await loadSettledCosts(signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}

async function loadBriefTitle(id: string, signal?: AbortSignal): Promise<string | null> {
  try {
    return (await getBrief(id, signal)).title;
  } catch (error) {
    if (error instanceof BriefEditorRequestError && error.status === 404) return null;
    throw error;
  }
}

function fallbackTitle(updatedAt: string) {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return '历史内容';
  return `历史内容 · ${date.toLocaleDateString('zh-CN')}`;
}

export async function loadCurrentUserId(signal?: AbortSignal): Promise<string> {
  const response = await request('/api/v1/auth/session', signal);
  const parsed = SessionResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new ContentPackageListRequestError(502);
  return parsed.data.data.user.id;
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
  const response = await fetch(`${API_ORIGIN}${path}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
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
