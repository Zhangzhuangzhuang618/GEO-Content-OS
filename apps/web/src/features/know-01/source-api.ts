import {
  SourceDetailSchema,
  SourcePageSchema,
  type SourceListItem,
  type SourceStatus,
  type SourceType,
  type TrustLevel,
} from './source.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export interface SourceFilters {
  cursor?: string;
  projectId?: string;
  search?: string;
  sourceType?: SourceType;
  status?: SourceStatus;
  trustLevel?: TrustLevel;
  workspaceId?: string;
}

export async function listSources(
  filters: SourceFilters,
  signal?: AbortSignal,
): Promise<{ items: SourceListItem[]; nextCursor: string | null }> {
  const query = new URLSearchParams({ limit: '20' });
  if (!filters.projectId || !filters.workspaceId) throw new SourceRequestError(422);
  if (filters.cursor) query.set('cursor', filters.cursor);
  query.set('project_id', filters.projectId);
  if (filters.search) query.set('search', filters.search);
  if (filters.sourceType) query.set('source_type', filters.sourceType);
  if (filters.status) query.set('status', filters.status);
  if (filters.trustLevel) query.set('trust_level', filters.trustLevel);
  query.set('workspace_id', filters.workspaceId);
  const response = await fetch(`${API_ORIGIN}/api/v1/sources?${query}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new SourceRequestError(response.status);
  const parsed = SourcePageSchema.safeParse(await response.json());
  if (!parsed.success) throw new SourceRequestError(502);
  const items = await Promise.all(
    parsed.data.data.map(async (source) => {
      const detailQuery = new URLSearchParams({
        project_id: filters.projectId!,
        workspace_id: source.workspace_id,
      });
      const detailResponse = await fetch(
        `${API_ORIGIN}/api/v1/sources/${source.id}?${detailQuery}`,
        {
          credentials: 'include',
          method: 'GET',
          ...(signal ? { signal } : {}),
        },
      );
      if (!detailResponse.ok) throw new SourceRequestError(detailResponse.status);
      const detail = SourceDetailSchema.safeParse(await detailResponse.json());
      if (!detail.success) throw new SourceRequestError(502);
      const parsedAt =
        detail.data.data.ingest_jobs
          .map((job) => job.finished_at)
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) ?? null;
      return { ...source, parsed_at: parsedAt };
    }),
  );
  return { items, nextCursor: parsed.data.meta.next_cursor };
}

export async function reindexSource(source: SourceListItem, csrf: string): Promise<void> {
  const response = await fetch(`${API_ORIGIN}/api/v1/sources/${source.id}/reindex`, {
    body: JSON.stringify({
      expected_content_hash: source.content_hash,
      reason: '用户从资料列表请求重建索引',
    }),
    credentials: 'include',
    headers: writeHeaders(csrf, 'source-reindex'),
    method: 'POST',
  });
  if (!response.ok) throw new SourceRequestError(response.status);
}

export async function expireSource(source: SourceListItem, csrf: string): Promise<void> {
  const response = await fetch(`${API_ORIGIN}/api/v1/sources/${source.id}`, {
    body: JSON.stringify({ reason: '用户从资料列表将资料标记为失效' }),
    credentials: 'include',
    headers: { ...writeHeaders(csrf, 'source-expire'), 'if-match': `"${source.updated_at}"` },
    method: 'DELETE',
  });
  if (!response.ok) throw new SourceRequestError(response.status);
}

export class SourceRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Source request failed');
    this.name = 'SourceRequestError';
  }
}

function writeHeaders(csrf: string, operation: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'idempotency-key': `${operation}-${crypto.randomUUID()}`,
    'x-csrf-token': csrf,
  };
}
