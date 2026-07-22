import type { ContentVariant } from '../cont-03/content-package-list.schema';
import {
  ContentPackageDetailResponseSchema,
  ContentPackagePageSchema,
} from '../cont-03/content-package-list.schema';
import {
  ApprovedVariantDetailResponseSchema,
  PublishJobPageSchema,
  PublishJobResponseSchema,
  SchedulableVariantResponseSchema,
  type ApprovedContent,
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

export async function listApprovedContent(
  filters: Pick<PublishingCalendarFilters, 'platformCode' | 'workspaceId'>,
  signal?: AbortSignal,
): Promise<readonly ApprovedContent[]> {
  const query = new URLSearchParams({ limit: '100', status: 'approved' });
  if (filters.platformCode) query.set('platform_code', filters.platformCode);
  if (filters.workspaceId) query.set('workspace_id', filters.workspaceId);

  const pageResponse = await request(`/api/v1/content-packages?${query}`, signal);
  const page = ContentPackagePageSchema.safeParse(await pageResponse.json());
  if (!page.success) throw new PublishingCalendarRequestError(502);

  const packageDetails = await Promise.all(
    page.data.data.map(async (contentPackage) => {
      const response = await request(`/api/v1/content-packages/${contentPackage.id}`, signal);
      const parsed = ContentPackageDetailResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new PublishingCalendarRequestError(502);
      return parsed.data.data;
    }),
  );
  const approved = packageDetails.flatMap((detail) =>
    detail.variants
      .filter((variant) => variant.status === 'approved')
      .map((variant) => ({ package: detail.package, variant })),
  );

  return Promise.all(
    approved.map(async ({ package: contentPackage, variant }) => {
      const response = await request(`/api/v1/content-variants/${variant.id}`, signal);
      const parsed = ApprovedVariantDetailResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new PublishingCalendarRequestError(502);
      return {
        packageId: contentPackage.id,
        title: parsed.data.data.current_content?.content_json.title ?? '未命名内容',
        updatedAt: variant.updated_at,
        variant,
      };
    }),
  );
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

async function request(path: string, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new PublishingCalendarRequestError(response.status);
  return response;
}
