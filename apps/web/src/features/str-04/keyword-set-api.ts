import {
  KeywordListResponseSchema,
  KeywordSetDetailResponseSchema,
  KeywordSetPageSchema,
  type KeywordInput,
  type KeywordSet,
  type KeywordSetDetail,
} from './keyword-set.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function listKeywordSets(
  filters: { readonly projectId?: string; readonly status?: 'active' | 'archived' },
  signal?: AbortSignal,
): Promise<KeywordSet[]> {
  const query = new URLSearchParams({ limit: '100' });
  if (filters.projectId) query.set('project_id', filters.projectId);
  if (filters.status) query.set('status', filters.status);
  const response = await fetch(`${API_ORIGIN}/api/v1/keyword-sets?${query}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new KeywordSetRequestError(response.status);
  const parsed = KeywordSetPageSchema.safeParse(await response.json());
  if (!parsed.success) throw new KeywordSetRequestError(502);
  return parsed.data.data;
}

export async function getKeywordSet(id: string, signal?: AbortSignal): Promise<KeywordSetDetail> {
  const response = await fetch(`${API_ORIGIN}/api/v1/keyword-sets/${id}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new KeywordSetRequestError(response.status);
  const parsed = KeywordSetDetailResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new KeywordSetRequestError(502);
  return parsed.data.data;
}

export async function upsertKeywords(
  keywordSetId: string,
  keywords: readonly KeywordInput[],
  csrf: string,
) {
  const response = await fetch(`${API_ORIGIN}/api/v1/keyword-sets/${keywordSetId}/keywords`, {
    body: JSON.stringify({ keywords }),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `keyword-upsert-${crypto.randomUUID()}`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  if (!response.ok) throw new KeywordSetRequestError(response.status);
  const parsed = KeywordListResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new KeywordSetRequestError(502);
  return parsed.data.data;
}

export class KeywordSetRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Keyword set request failed');
    this.name = 'KeywordSetRequestError';
  }
}
