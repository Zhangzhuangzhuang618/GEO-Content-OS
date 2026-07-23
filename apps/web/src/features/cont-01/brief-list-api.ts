import { BriefPageSchema, type Brief, type BriefFilters } from './brief-list.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function listBriefs(
  filters: BriefFilters,
  signal?: AbortSignal,
): Promise<{ readonly items: Brief[]; readonly nextCursor: string | null }> {
  const query = new URLSearchParams({ limit: '20' });
  if (filters.createdBy) query.set('created_by', filters.createdBy);
  if (filters.cursor) query.set('cursor', filters.cursor);
  if (filters.objective) query.set('objective', filters.objective);
  if (filters.platformCode) query.set('platform_code', filters.platformCode);
  if (filters.projectId) query.set('project_id', filters.projectId);
  if (filters.search) query.set('search', filters.search);
  const response = await fetch(`${API_ORIGIN}/api/v1/briefs?${query}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new BriefListRequestError(response.status);
  const parsed = BriefPageSchema.safeParse(await response.json());
  if (!parsed.success) throw new BriefListRequestError(502);
  return { items: parsed.data.data, nextCursor: parsed.data.meta.next_cursor };
}

export class BriefListRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Brief list request failed');
    this.name = 'BriefListRequestError';
  }
}
