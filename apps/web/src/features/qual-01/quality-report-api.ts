import { createRequestUuid } from '@/lib/request-uuid';

import {
  QualityMutationResponseSchema,
  QualityVariantDetailResponseSchema,
  type QualityVariantDetail,
} from './quality-report.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function getQualityVariantDetail(
  id: string,
  signal?: AbortSignal,
): Promise<QualityVariantDetail> {
  const response = await fetch(`${API_ORIGIN}/api/v1/content-variants/${id}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new QualityReportRequestError(response.status);
  const parsed = QualityVariantDetailResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new QualityReportRequestError(502);
  return parsed.data.data;
}

export async function requestQualityCheck(variantId: string, csrf: string): Promise<void> {
  await write(`/api/v1/content-variants/${variantId}/quality-check`, csrf, {
    body: { mode: 'full' },
    operation: 'quality-check',
  });
}

export async function rewriteQualityVariant(
  variantId: string,
  variantVersion: number,
  qualityReportId: string,
  lockedBlockKeys: readonly string[],
  csrf: string,
): Promise<void> {
  const response = await fetch(`${API_ORIGIN}/api/v1/content-variants/${variantId}/regenerate`, {
    body: JSON.stringify({
      locked_block_keys: lockedBlockKeys,
      model_policy: 'balanced',
      quality_report_id: qualityReportId,
    }),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `quality-rewrite-${createRequestUuid()}`,
      'if-match': `"${variantVersion}"`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  if (!response.ok) throw new QualityReportRequestError(response.status);
  const parsed = QualityMutationResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new QualityReportRequestError(502);
}

export async function submitQualityPassedVariant(
  packageId: string,
  variantId: string,
  csrf: string,
): Promise<void> {
  await write(`/api/v1/content-packages/${packageId}/submit-review`, csrf, {
    body: { variant_ids: [variantId] },
    operation: 'quality-submit-review',
  });
}

async function write(
  path: string,
  csrf: string,
  input: {
    readonly body: Readonly<Record<string, unknown>>;
    readonly operation: string;
  },
) {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    body: JSON.stringify(input.body),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `${input.operation}-${createRequestUuid()}`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  if (!response.ok) throw new QualityReportRequestError(response.status);
  const parsed = QualityMutationResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new QualityReportRequestError(502);
}

export class QualityReportRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Quality report request failed');
    this.name = 'QualityReportRequestError';
  }
}
