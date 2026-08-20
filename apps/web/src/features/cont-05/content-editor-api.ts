import { createRequestUuid } from '@/lib/request-uuid';

import {
  ContentDiffResponseSchema,
  ContentVersionSchema,
  GenerationResponseSchema,
  VariantDetailResponseSchema,
  type ContentDiff,
  type ContentDocument,
  type ModelPolicy,
  type VariantDetail,
} from './content-editor.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function getVariantDetail(id: string, signal?: AbortSignal): Promise<VariantDetail> {
  const response = await fetch(`${API_ORIGIN}/api/v1/content-variants/${id}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  return parseDetail(response);
}

export async function saveVariant(detail: VariantDetail, content: ContentDocument, csrf: string) {
  const response = await fetch(`${API_ORIGIN}/api/v1/content-variants/${detail.variant.id}`, {
    body: JSON.stringify({ content }),
    credentials: 'include',
    headers: writeHeaders('content-variant-save', csrf, detail.variant.version),
    method: 'PATCH',
  });
  return parseDetail(response);
}

export async function setBlockLock(
  detail: VariantDetail,
  blockId: string,
  lock: boolean,
  reason: string,
  csrf: string,
) {
  const response = await fetch(
    `${API_ORIGIN}/api/v1/content-variants/${detail.variant.id}/blocks/${blockId}/lock`,
    {
      ...(lock ? { body: JSON.stringify({ reason: reason.trim() || null }) } : {}),
      credentials: 'include',
      headers: {
        ...(lock ? { 'content-type': 'application/json' } : {}),
        'if-match': `"${detail.variant.version}"`,
        'x-csrf-token': csrf,
      },
      method: lock ? 'POST' : 'DELETE',
    },
  );
  if (!response.ok) throw new ContentEditorRequestError(response.status);
}

export async function regenerateVariant(
  detail: VariantDetail,
  modelPolicy: ModelPolicy,
  csrf: string,
) {
  const response = await fetch(
    `${API_ORIGIN}/api/v1/content-variants/${detail.variant.id}/regenerate`,
    {
      body: JSON.stringify({
        locked_block_keys: detail.locks.map((lock) => lock.block_key),
        model_policy: modelPolicy,
      }),
      credentials: 'include',
      headers: writeHeaders('content-variant-regenerate', csrf, detail.variant.version),
      method: 'POST',
    },
  );
  if (!response.ok) throw new ContentEditorRequestError(response.status);
  const parsed = GenerationResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new ContentEditorRequestError(502);
}

export async function requestManualEditQuality(
  variantId: string,
  sourcePublishJobId: string,
  csrf: string,
) {
  const response = await fetch(`${API_ORIGIN}/api/v1/content-variants/${variantId}/quality-check`, {
    body: JSON.stringify({
      mode: 'manual_edit',
      source_publish_job_id: sourcePublishJobId,
    }),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `content-publish-edit-quality-${createRequestUuid()}`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  if (!response.ok) throw new ContentEditorRequestError(response.status);
  const parsed = GenerationResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new ContentEditorRequestError(502);
}

export async function loadVersionDiff(baseId: string, targetId: string): Promise<ContentDiff> {
  const query = new URLSearchParams({ target_version_id: targetId });
  const response = await fetch(`${API_ORIGIN}/api/v1/content-versions/${baseId}/diff?${query}`, {
    credentials: 'include',
    method: 'GET',
  });
  if (!response.ok) throw new ContentEditorRequestError(response.status);
  const parsed = ContentDiffResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new ContentEditorRequestError(502);
  return parsed.data.data;
}

export async function rollbackVersion(
  detail: VariantDetail,
  versionId: string,
  reason: string,
  csrf: string,
) {
  const response = await fetch(`${API_ORIGIN}/api/v1/content-versions/${versionId}/rollback`, {
    body: JSON.stringify({ reason: reason.trim() || null }),
    credentials: 'include',
    headers: writeHeaders('content-version-rollback', csrf, detail.variant.version),
    method: 'POST',
  });
  if (!response.ok) throw new ContentEditorRequestError(response.status);
  const body = await response.json();
  const parsed = ContentVersionSchema.safeParse(body?.data);
  if (!parsed.success) throw new ContentEditorRequestError(502);
}

function writeHeaders(operation: string, csrf: string, version: number) {
  return {
    'content-type': 'application/json',
    'idempotency-key': `${operation}-${createRequestUuid()}`,
    'if-match': `"${version}"`,
    'x-csrf-token': csrf,
  };
}

async function parseDetail(response: Response) {
  if (!response.ok) throw new ContentEditorRequestError(response.status);
  const parsed = VariantDetailResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new ContentEditorRequestError(502);
  return parsed.data.data;
}

export class ContentEditorRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Content editor request failed');
    this.name = 'ContentEditorRequestError';
  }
}
