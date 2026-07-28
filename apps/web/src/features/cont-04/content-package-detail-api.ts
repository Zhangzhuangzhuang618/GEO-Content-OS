import { createRequestUuid } from '@/lib/request-uuid';

import { ContentPackageResponseSchema } from '../cont-03/content-package-list.schema';
import {
  ContentPackageBaseDetailResponseSchema,
  ContentVariantDetailResponseSchema,
  GenerationRunResponseSchema,
  MutationSuccessSchema,
  type ModelPolicy,
  type PackageDetail,
} from './content-package-detail.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function getContentPackageDetail(
  id: string,
  signal?: AbortSignal,
): Promise<PackageDetail> {
  const response = await request(`/api/v1/content-packages/${id}`, signal);
  const parsed = ContentPackageBaseDetailResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new ContentPackageDetailRequestError(502);
  const variants = await Promise.all(
    parsed.data.data.variants.map(async (variant) => {
      const detailResponse = await request(`/api/v1/content-variants/${variant.id}`, signal);
      const detail = ContentVariantDetailResponseSchema.safeParse(await detailResponse.json());
      if (!detail.success) throw new ContentPackageDetailRequestError(502);
      return {
        automationRun: detail.data.data.automation_run,
        citations: detail.data.data.citations,
        currentContent: detail.data.data.current_content,
        qualityReport: detail.data.data.quality_report,
        qualityReports: detail.data.data.quality_reports,
        variant: detail.data.data.variant,
        versions: detail.data.data.versions,
      };
    }),
  );
  return {
    generationRuns: parsed.data.data.generation_runs,
    masterContent: parsed.data.data.master_content,
    package: parsed.data.data.package,
    variants,
  };
}

export async function generatePackage(
  detail: PackageDetail,
  modelPolicy: ModelPolicy,
  csrf: string,
) {
  const response = await write(`/api/v1/content-packages/${detail.package.id}/generate`, csrf, {
    body: {
      locked_block_keys: [],
      model_policy: modelPolicy,
      platform_codes: detail.variants
        .filter((item) => item.variant.is_required)
        .map((item) => item.variant.platform_code),
    },
    operation: 'content-package-generate',
    version: detail.package.version,
  });
  const parsed = GenerationRunResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new ContentPackageDetailRequestError(502);
}

export async function mutatePackage(
  detail: PackageDetail,
  action: 'abandon' | 'archive',
  reason: string,
  csrf: string,
) {
  const response = await write(`/api/v1/content-packages/${detail.package.id}/${action}`, csrf, {
    body: { reason },
    operation: `content-package-${action}`,
    version: detail.package.version,
  });
  const parsed = ContentPackageResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new ContentPackageDetailRequestError(502);
}

export async function submitPackageReview(
  detail: PackageDetail,
  variantIds: readonly string[],
  csrf: string,
) {
  const response = await write(
    `/api/v1/content-packages/${detail.package.id}/submit-review`,
    csrf,
    {
      body: { variant_ids: variantIds },
      operation: 'content-package-submit-review',
    },
  );
  const parsed = MutationSuccessSchema.safeParse(await response.json());
  if (!parsed.success) throw new ContentPackageDetailRequestError(502);
}

export async function requestPackageQualityChecks(variantIds: readonly string[], csrf: string) {
  await Promise.all(
    variantIds.map(async (variantId) => {
      const response = await write(`/api/v1/content-variants/${variantId}/quality-check`, csrf, {
        body: { mode: 'full' },
        operation: 'content-variant-quality-check',
      });
      const parsed = GenerationRunResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new ContentPackageDetailRequestError(502);
    }),
  );
}

export async function regenerateVariant(
  variantId: string,
  version: number,
  modelPolicy: ModelPolicy,
  csrf: string,
) {
  const response = await write(`/api/v1/content-variants/${variantId}/regenerate`, csrf, {
    body: {
      locked_block_keys: [],
      model_policy: modelPolicy,
    },
    operation: 'content-variant-regenerate',
    version,
  });
  const parsed = GenerationRunResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new ContentPackageDetailRequestError(502);
}

async function request(path: string, signal?: AbortSignal) {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new ContentPackageDetailRequestError(response.status);
  return response;
}

async function write(
  path: string,
  csrf: string,
  input: {
    readonly body: Readonly<Record<string, unknown>>;
    readonly operation: string;
    readonly version?: number;
  },
) {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    body: JSON.stringify(input.body),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `${input.operation}-${createRequestUuid()}`,
      ...(input.version === undefined ? {} : { 'if-match': `"${input.version}"` }),
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  if (!response.ok) throw new ContentPackageDetailRequestError(response.status);
  return response;
}

export class ContentPackageDetailRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Content package detail request failed');
    this.name = 'ContentPackageDetailRequestError';
  }
}
