import { apiGet } from '@/lib/api-fetch';
import { createRequestUuid } from '@/lib/request-uuid';

import {
  BatchUrlPreviewResponseSchema,
  ProjectPageSchema,
  UploadResponseSchema,
  type ProjectChoice,
  type UploadForm,
  type UploadResult,
  type BatchUrlPreview,
} from './source-upload.schema';
const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';
export async function listProjects(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<ProjectChoice[]> {
  const query = new URLSearchParams({ limit: '100', status: 'active', workspace_id: workspaceId });
  const response = await apiGet(`${API_ORIGIN}/api/v1/projects?${query}`, {
    cacheTtlMs: 30_000,
    signal,
  });
  if (!response.ok) throw createUploadRequestError(response);
  const parsed = ProjectPageSchema.safeParse(await response.json());
  if (!parsed.success) throw new UploadRequestError(502);
  return parsed.data.data;
}
export async function uploadSource(
  input: { file: File | null; form: UploadForm; mode: 'file' | 'url' },
  csrf: string,
): Promise<UploadResult> {
  const body = new FormData();
  body.set('title', input.form.title.trim());
  body.set('language', input.form.language);
  body.set('workspace_id', input.form.workspace_id);
  body.set('trust_level', input.form.trust_level);
  if (input.form.project_id) body.set('project_id', input.form.project_id);
  if (input.form.effective_from) body.set('effective_from', input.form.effective_from);
  if (input.form.effective_to) body.set('effective_to', input.form.effective_to);
  if (input.form.material_kind === 'certificate') {
    body.set('material_kind', 'certificate');
    body.set('article_use_allowed', String(input.form.article_use_allowed));
    body.set('certificate_name', input.form.certificate_name.trim());
    body.set('certificate_number', input.form.certificate_number.trim());
    body.set('holder_name', input.form.holder_name.trim());
    body.set('issuing_authority', input.form.issuing_authority.trim());
    body.set('public_display_confirmed', String(input.form.public_display_confirmed));
    if (input.form.verification_url)
      body.set('verification_url', input.form.verification_url.trim());
  }
  if (input.mode === 'file' && input.file) body.set('file', input.file);
  if (input.mode === 'url') body.set('url', input.form.url.trim());
  const response = await fetch(`${API_ORIGIN}/api/v1/sources`, {
    body,
    credentials: 'include',
    headers: { 'idempotency-key': `source-upload-${createRequestUuid()}`, 'x-csrf-token': csrf },
    method: 'POST',
  });
  if (!response.ok) throw createUploadRequestError(response);
  const parsed = UploadResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new UploadRequestError(502);
  return parsed.data.data;
}
export async function previewBatchUrls(
  input: {
    file: File;
    sheetName: string;
    startRow: string;
    titleColumn: string;
    urlColumn: string;
  },
  csrf: string,
): Promise<BatchUrlPreview> {
  const body = new FormData();
  body.set('file', input.file);
  if (input.sheetName.trim()) body.set('sheet_name', input.sheetName.trim());
  if (input.startRow.trim()) body.set('start_row', input.startRow.trim());
  if (input.titleColumn.trim()) body.set('title_column', input.titleColumn.trim());
  if (input.urlColumn.trim()) body.set('url_column', input.urlColumn.trim());
  const response = await fetch(`${API_ORIGIN}/api/v1/sources/batch-url-preview`, {
    body,
    credentials: 'include',
    headers: { 'x-csrf-token': csrf },
    method: 'POST',
  });
  if (!response.ok) throw createUploadRequestError(response);
  const parsed = BatchUrlPreviewResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new UploadRequestError(502);
  return parsed.data.data;
}
export class UploadRequestError extends Error {
  public constructor(
    public readonly status: number,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super('Source upload failed');
    this.name = 'UploadRequestError';
  }
}

function createUploadRequestError(response: Response): UploadRequestError {
  return new UploadRequestError(response.status, readRetryAfterSeconds(response));
}

function readRetryAfterSeconds(response: Response): number | null {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return null;
  if (/^\d+$/u.test(value)) return Number(value);
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return null;
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000));
}
