import { createRequestUuid } from '@/lib/request-uuid';

import {
  IngestJobResponseSchema,
  SourceDetailResponseSchema,
  SourceResponseSchema,
  type Source,
  type SourceDetailScope,
  type SourceDetailView,
} from './source-detail.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function getSourceDetail(
  scope: SourceDetailScope,
  signal?: AbortSignal,
): Promise<SourceDetailView> {
  const query = scopeQuery(scope);
  const response = await fetch(`${API_ORIGIN}/api/v1/sources/${scope.id}?${query}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new SourceDetailRequestError(response.status);
  const parsed = SourceDetailResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new SourceDetailRequestError(502);
  return parsed.data.data;
}

export async function retrySource(source: Source, csrf: string): Promise<string> {
  const response = await fetch(`${API_ORIGIN}/api/v1/sources/${source.id}/reindex`, {
    body: JSON.stringify({
      expected_content_hash: source.content_hash,
      reason: '用户从资料详情请求重试解析与索引',
    }),
    credentials: 'include',
    headers: writeHeaders(csrf, 'source-detail-reindex'),
    method: 'POST',
  });
  if (!response.ok) throw new SourceDetailRequestError(response.status);
  const parsed = IngestJobResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new SourceDetailRequestError(502);
  return parsed.data.data.id;
}

export async function expireSource(source: Source, csrf: string): Promise<void> {
  const response = await fetch(`${API_ORIGIN}/api/v1/sources/${source.id}`, {
    body: JSON.stringify({ reason: '用户从资料详情将资料标记为失效' }),
    credentials: 'include',
    headers: {
      ...writeHeaders(csrf, 'source-detail-expire'),
      'if-match': `"${source.updated_at}"`,
    },
    method: 'DELETE',
  });
  if (!response.ok) throw new SourceDetailRequestError(response.status);
}

export async function updateSourceValidity(
  source: Source,
  effectiveFrom: string | null,
  effectiveTo: string | null,
  csrf: string,
): Promise<Source> {
  const response = await fetch(`${API_ORIGIN}/api/v1/sources/${source.id}/validity`, {
    body: JSON.stringify({
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      reason: '用户从资料详情修正有效期',
    }),
    credentials: 'include',
    headers: {
      ...writeHeaders(csrf, 'source-detail-validity'),
      'if-match': `"${source.updated_at}"`,
    },
    method: 'PATCH',
  });
  if (!response.ok) throw new SourceDetailRequestError(response.status);
  const parsed = SourceResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new SourceDetailRequestError(502);
  return parsed.data.data;
}

export class SourceDetailRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Source detail request failed');
    this.name = 'SourceDetailRequestError';
  }
}

function scopeQuery(scope: SourceDetailScope): URLSearchParams {
  return new URLSearchParams({ project_id: scope.projectId, workspace_id: scope.workspaceId });
}

function writeHeaders(csrf: string, operation: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'idempotency-key': `${operation}-${createRequestUuid()}`,
    'x-csrf-token': csrf,
  };
}
