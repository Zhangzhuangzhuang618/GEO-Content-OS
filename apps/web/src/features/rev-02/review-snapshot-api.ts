import { RequirementResponseSchema, ReviewSnapshotResponseSchema } from './review-snapshot.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function getReviewSnapshot(id: string, signal?: AbortSignal) {
  const response = await fetch(`${API_ORIGIN}/api/v1/review-snapshots/${id}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new ReviewSnapshotRequestError(response.status);
  const parsed = ReviewSnapshotResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new ReviewSnapshotRequestError(502);
  return parsed.data.data;
}

export async function decideReview(input: {
  readonly action: 'approve' | 'reject';
  readonly comment: string | null;
  readonly csrf: string;
  readonly snapshotId: string;
  readonly variantId: string;
  readonly version: number;
}) {
  const response = await write(input.snapshotId, input.action, input.version, input.csrf, {
    comment: input.comment,
    variant_ids: [input.variantId],
  });
  const parsed = ReviewSnapshotResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new ReviewSnapshotRequestError(502);
  return parsed.data.data;
}

export async function requestReviewSignoff(input: {
  readonly comment: string | null;
  readonly csrf: string;
  readonly requiredRole: string;
  readonly snapshotId: string;
  readonly variantId: string;
  readonly version: number;
}) {
  const response = await write(input.snapshotId, 'request-signoff', input.version, input.csrf, {
    comment: input.comment,
    required_role: input.requiredRole,
    variant_id: input.variantId,
  });
  const parsed = RequirementResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new ReviewSnapshotRequestError(502);
  return parsed.data.data;
}

async function write(
  snapshotId: string,
  action: string,
  version: number,
  csrf: string,
  body: Readonly<Record<string, unknown>>,
) {
  const response = await fetch(`${API_ORIGIN}/api/v1/review-snapshots/${snapshotId}/${action}`, {
    body: JSON.stringify(body),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `review-${action}-${crypto.randomUUID()}`,
      'if-match': `"${version}"`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  if (!response.ok) throw new ReviewSnapshotRequestError(response.status);
  return response;
}

export class ReviewSnapshotRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Review snapshot request failed');
    this.name = 'ReviewSnapshotRequestError';
  }
}
