import { createRequestUuid } from '@/lib/request-uuid';

import {
  BatchKeywordOperationResponseSchema,
  KeywordListResponseSchema,
  KeywordImportJobResponseSchema,
  KeywordPageSchema,
  KeywordSetDetailResponseSchema,
  KeywordSetPageSchema,
  KeywordSetResponseSchema,
  type KeywordInput,
  type KeywordImportJob,
  type KeywordIntent,
  type KeywordSort,
  type KeywordSourceIntent,
  type KeywordStatus,
  type KeywordSuggestedPageType,
  type PlatformCode,
  type KeywordSet,
  type KeywordSetDetail,
} from './keyword-set.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function createKeywordSet(
  input: { readonly name: string; readonly projectId: string },
  csrf: string,
): Promise<KeywordSet> {
  const response = await fetch(`${API_ORIGIN}/api/v1/keyword-sets`, {
    body: JSON.stringify({ name: input.name, project_id: input.projectId }),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `keyword-set-create-${createRequestUuid()}`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  if (!response.ok) throw new KeywordSetRequestError(response.status);
  const parsed = KeywordSetResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new KeywordSetRequestError(502);
  return parsed.data.data;
}

export async function listKeywordSets(
  filters: { readonly projectId?: string; readonly status?: 'active' | 'archived' },
  signal?: AbortSignal,
): Promise<KeywordSet[]> {
  const items: KeywordSet[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (filters.projectId) query.set('project_id', filters.projectId);
    if (filters.status) query.set('status', filters.status);
    if (cursor) query.set('cursor', cursor);
    const response = await fetch(`${API_ORIGIN}/api/v1/keyword-sets?${query}`, {
      credentials: 'include',
      method: 'GET',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new KeywordSetRequestError(response.status);
    const parsed = KeywordSetPageSchema.safeParse(await response.json());
    if (!parsed.success) throw new KeywordSetRequestError(502);
    items.push(...parsed.data.data);
    cursor = parsed.data.meta.next_cursor;
    if (cursor && seenCursors.has(cursor)) throw new KeywordSetRequestError(502);
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return items;
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
      'idempotency-key': `keyword-upsert-${createRequestUuid()}`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  if (!response.ok) throw new KeywordSetRequestError(response.status);
  const parsed = KeywordListResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new KeywordSetRequestError(502);
  return parsed.data.data;
}

export async function listKeywords(
  keywordSetId: string,
  input: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly page?: number;
    readonly platformCode?: PlatformCode;
    readonly search?: string;
    readonly sort?: KeywordSort;
    readonly status?: KeywordStatus;
  },
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ limit: String(input.limit ?? 20) });
  if (input.cursor) query.set('cursor', input.cursor);
  if (input.page) query.set('page', String(input.page));
  if (input.platformCode) query.set('platform_code', input.platformCode);
  if (input.search) query.set('search', input.search);
  if (input.sort) query.set('sort', input.sort);
  if (input.status) query.set('status', input.status);
  const response = await fetch(
    `${API_ORIGIN}/api/v1/keyword-sets/${keywordSetId}/keywords?${query}`,
    {
      credentials: 'include',
      method: 'GET',
      ...(signal ? { signal } : {}),
    },
  );
  if (!response.ok) throw new KeywordSetRequestError(response.status);
  const parsed = KeywordPageSchema.safeParse(await response.json());
  if (!parsed.success) throw new KeywordSetRequestError(502);
  return parsed.data;
}

export async function batchKeywords(
  keywordSetId: string,
  input: (
    | { readonly action: 'delete' | 'disable' }
    | {
        readonly action: 'update';
        readonly changes: {
          readonly intents?: readonly KeywordIntent[];
          readonly platform_scope?: readonly PlatformCode[];
          readonly priority?: number;
          readonly status?: KeywordStatus;
        };
      }
  ) &
    (
      | { readonly keywordIds: readonly string[] }
      | {
          readonly selection: {
            readonly mode: 'all_filtered';
            readonly platform_code?: PlatformCode;
            readonly search?: string;
            readonly status?: KeywordStatus;
          };
        }
    ),
  csrf: string,
) {
  const target =
    'selection' in input ? { selection: input.selection } : { keyword_ids: input.keywordIds };
  const response = await fetch(`${API_ORIGIN}/api/v1/keyword-sets/${keywordSetId}/keywords/batch`, {
    body: JSON.stringify({
      action: input.action,
      ...(input.action === 'update' ? { changes: input.changes } : {}),
      ...target,
    }),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `keyword-batch-${createRequestUuid()}`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  if (!response.ok) throw new KeywordSetRequestError(response.status);
  const parsed = BatchKeywordOperationResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new KeywordSetRequestError(502);
  return parsed.data.data;
}

export async function preflightKeywordImport(
  keywordSetId: string,
  file: File,
  sheetName: string,
  csrf: string,
): Promise<KeywordImportJob> {
  const form = new FormData();
  form.set('file', file);
  if (sheetName.trim()) form.set('sheet_name', sheetName.trim());
  const response = await fetch(
    `${API_ORIGIN}/api/v1/keyword-sets/${keywordSetId}/imports/preflight`,
    {
      body: form,
      credentials: 'include',
      headers: {
        'idempotency-key': `keyword-import-preflight-${createRequestUuid()}`,
        'x-csrf-token': csrf,
      },
      method: 'POST',
    },
  );
  if (!response.ok) throw new KeywordSetRequestError(response.status);
  const parsed = KeywordImportJobResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new KeywordSetRequestError(502);
  return parsed.data.data;
}

export async function commitKeywordImport(
  keywordSetId: string,
  importJobId: string,
  input: {
    readonly platformScope: readonly PlatformCode[];
    readonly priority: number;
    readonly selectedPageTypes: readonly KeywordSuggestedPageType[];
    readonly selectedSourceIntents: readonly KeywordSourceIntent[];
    readonly status: KeywordStatus;
  },
  csrf: string,
): Promise<KeywordImportJob> {
  const response = await fetch(
    `${API_ORIGIN}/api/v1/keyword-sets/${keywordSetId}/imports/${importJobId}/commit`,
    {
      body: JSON.stringify({
        platform_scope: input.platformScope,
        priority: input.priority,
        selected_page_types: input.selectedPageTypes,
        selected_source_intents: input.selectedSourceIntents,
        status: input.status,
      }),
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `keyword-import-commit-${createRequestUuid()}`,
        'x-csrf-token': csrf,
      },
      method: 'POST',
    },
  );
  if (!response.ok) throw new KeywordSetRequestError(response.status);
  const parsed = KeywordImportJobResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new KeywordSetRequestError(502);
  return parsed.data.data;
}

export async function getKeywordImport(
  keywordSetId: string,
  importJobId: string,
  signal?: AbortSignal,
): Promise<KeywordImportJob> {
  const response = await fetch(
    `${API_ORIGIN}/api/v1/keyword-sets/${keywordSetId}/imports/${importJobId}`,
    {
      credentials: 'include',
      method: 'GET',
      ...(signal ? { signal } : {}),
    },
  );
  if (!response.ok) throw new KeywordSetRequestError(response.status);
  const parsed = KeywordImportJobResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new KeywordSetRequestError(502);
  return parsed.data.data;
}

export class KeywordSetRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Keyword set request failed');
    this.name = 'KeywordSetRequestError';
  }
}
