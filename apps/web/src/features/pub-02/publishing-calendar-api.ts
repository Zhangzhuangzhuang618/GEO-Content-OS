import type { ContentVariant } from '../cont-03/content-package-list.schema';
import {
  PublishJobPageSchema,
  PublishJobResponseSchema,
  SchedulableVariantResponseSchema,
  type PublishJob,
  type PublishingCalendarFilters,
} from './publishing-calendar.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function listPublishJobs(
  filters: PublishingCalendarFilters,
  signal?: AbortSignal,
): Promise<readonly PublishJob[]> {
  const query = new URLSearchParams({ limit: '100' });
  if (filters.accountId) query.set('account_id', filters.accountId);
  if (filters.from) query.set('from', filters.from);
  if (filters.platformCode) query.set('platform_code', filters.platformCode);
  if (filters.status) query.set('status', filters.status);
  if (filters.to) query.set('to', filters.to);
  if (filters.workspaceId) query.set('workspace_id', filters.workspaceId);
  const response = await fetch(`${API_ORIGIN}/api/v1/publish-jobs?${query}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new PublishingCalendarRequestError(response.status);
  const parsed = PublishJobPageSchema.safeParse(await response.json());
  if (!parsed.success) throw new PublishingCalendarRequestError(502);
  return parsed.data.data;
}

export async function getSchedulableVariant(
  variantId: string,
  signal?: AbortSignal,
): Promise<ContentVariant> {
  const response = await fetch(`${API_ORIGIN}/api/v1/content-variants/${variantId}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new PublishingCalendarRequestError(response.status);
  const parsed = SchedulableVariantResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PublishingCalendarRequestError(502);
  return parsed.data.data.variant;
}

export async function createPublishJob(
  accountId: string,
  variantId: string,
  scheduledAt: string,
  csrf: string,
): Promise<PublishJob> {
  const response = await fetch(`${API_ORIGIN}/api/v1/publish-jobs`, {
    body: JSON.stringify({
      account_id: accountId,
      scheduled_at: scheduledAt,
      variant_id: variantId,
    }),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `publish-calendar-${crypto.randomUUID()}`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  return parseJob(response);
}

export async function cancelPublishJob(
  job: PublishJob,
  reason: string,
  csrf: string,
): Promise<PublishJob> {
  const response = await fetch(`${API_ORIGIN}/api/v1/publish-jobs/${job.id}/cancel`, {
    body: JSON.stringify({ reason }),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'if-match': `"${job.version}"`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  return parseJob(response);
}

export class PublishingCalendarRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Publishing calendar request failed');
    this.name = 'PublishingCalendarRequestError';
  }
}

async function parseJob(response: Response): Promise<PublishJob> {
  if (!response.ok) throw new PublishingCalendarRequestError(response.status);
  const parsed = PublishJobResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PublishingCalendarRequestError(502);
  return parsed.data.data;
}
