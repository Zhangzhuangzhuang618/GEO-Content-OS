import { createRequestUuid } from '@/lib/request-uuid';

import type { PublishJob } from '../pub-02/publishing-calendar.schema';
import {
  PublishJobDetailResponseSchema,
  PublishJobResponseSchema,
  PublishMediaRunResponseSchema,
  SignedDownloadResponseSchema,
  type PublishJobDetail,
  type SignedDownload,
} from './publish-job-detail.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function getPublishJobDetail(
  jobId: string,
  signal?: AbortSignal,
): Promise<PublishJobDetail> {
  const response = await fetch(`${API_ORIGIN}/api/v1/publish-jobs/${jobId}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new PublishJobDetailRequestError(response.status);
  const parsed = PublishJobDetailResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PublishJobDetailRequestError(502);
  return parsed.data.data;
}

export async function retryPublishJob(
  job: PublishJob,
  csrf: string,
  scheduledAt?: string,
): Promise<PublishJob> {
  const response = await fetch(`${API_ORIGIN}/api/v1/publish-jobs/${job.id}/retry`, {
    body: JSON.stringify(scheduledAt ? { scheduled_at: scheduledAt } : {}),
    credentials: 'include',
    headers: writeHeaders(csrf, job.version, `publish-retry-${job.id}`),
    method: 'POST',
  });
  return parseJob(response);
}

export async function resolveUnknownPublishJob(
  job: PublishJob,
  csrf: string,
  input:
    | { readonly resolution: 'not_published' }
    | { readonly resolution: 'not_published_closed' }
    | {
        readonly external_post_id?: string;
        readonly external_url: string;
        readonly resolution: 'published';
      },
): Promise<PublishJob> {
  const response = await fetch(`${API_ORIGIN}/api/v1/publish-jobs/${job.id}/resolve-unknown`, {
    body: JSON.stringify(input),
    credentials: 'include',
    headers: writeHeaders(csrf, job.version, `publish-resolve-unknown-${job.id}`),
    method: 'POST',
  });
  return parseJob(response);
}

export async function reconcileBaijiahaoPublishJob(
  job: PublishJob,
  csrf: string,
): Promise<PublishJob> {
  const response = await fetch(`${API_ORIGIN}/api/v1/publish-jobs/${job.id}/reconcile`, {
    body: JSON.stringify({}),
    credentials: 'include',
    headers: writeHeaders(csrf, job.version, `publish-reconcile-${job.id}`),
    method: 'POST',
  });
  return parseJob(response);
}

export async function cancelUnexecutedPublishJob(
  job: PublishJob,
  reason: string,
  csrf: string,
): Promise<PublishJob> {
  const response = await fetch(`${API_ORIGIN}/api/v1/publish-jobs/${job.id}/cancel`, {
    body: JSON.stringify({ reason }),
    credentials: 'include',
    headers: writeHeaders(csrf, job.version),
    method: 'POST',
  });
  return parseJob(response);
}

export async function getSignedExport(jobId: string): Promise<SignedDownload> {
  const response = await fetch(`${API_ORIGIN}/api/v1/publish-jobs/${jobId}/export`, {
    credentials: 'include',
    method: 'GET',
  });
  if (!response.ok) throw new PublishJobDetailRequestError(response.status);
  const parsed = SignedDownloadResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PublishJobDetailRequestError(502);
  return parsed.data.data;
}

export async function generatePublishJobMedia(job: PublishJob, csrf: string): Promise<void> {
  const response = await fetch(`${API_ORIGIN}/api/v1/publish-jobs/${job.id}/media`, {
    body: JSON.stringify({}),
    credentials: 'include',
    headers: writeHeaders(csrf, job.version, `publish-media-${job.id}`),
    method: 'POST',
  });
  if (!response.ok) throw new PublishJobDetailRequestError(response.status);
  const parsed = PublishMediaRunResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PublishJobDetailRequestError(502);
}

export class PublishJobDetailRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Publish job detail request failed');
    this.name = 'PublishJobDetailRequestError';
  }
}

async function parseJob(response: Response): Promise<PublishJob> {
  if (!response.ok) throw new PublishJobDetailRequestError(response.status);
  const parsed = PublishJobResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PublishJobDetailRequestError(502);
  return parsed.data.data;
}

function writeHeaders(csrf: string, version: number, idempotencyKey?: string) {
  return {
    'content-type': 'application/json',
    ...(idempotencyKey ? { 'idempotency-key': `${idempotencyKey}-${createRequestUuid()}` } : {}),
    'if-match': `"${version}"`,
    'x-csrf-token': csrf,
  };
}
