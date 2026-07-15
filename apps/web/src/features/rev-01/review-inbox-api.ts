import {
  ReviewClaimResponseSchema,
  ReviewInboxPageSchema,
  type ReviewFilters,
  type RiskLevel,
} from './review-inbox.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function listReviewInbox(filters: ReviewFilters, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: '20' });
  if (filters.claimState) query.set('claim_state', filters.claimState);
  if (filters.createdBy) query.set('created_by', filters.createdBy);
  if (filters.cursor) query.set('cursor', filters.cursor);
  if (filters.platformCode) query.set('platform_code', filters.platformCode);
  if (filters.projectId) query.set('project_id', filters.projectId);
  if (filters.riskLevel) query.set('risk_level', filters.riskLevel);
  if (filters.status) query.set('status', filters.status);
  if (filters.workspaceId) query.set('workspace_id', filters.workspaceId);
  const response = await fetch(`${API_ORIGIN}/api/v1/review-snapshots?${query}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new ReviewInboxRequestError(response.status);
  const parsed = ReviewInboxPageSchema.safeParse(await response.json());
  if (!parsed.success) throw new ReviewInboxRequestError(502);
  return { items: parsed.data.data, nextCursor: parsed.data.meta.next_cursor };
}

export async function claimReview(
  snapshotId: string,
  version: number,
  riskLevel: RiskLevel,
  dueAt: string,
  csrf: string,
) {
  const response = await fetch(`${API_ORIGIN}/api/v1/review-snapshots/${snapshotId}/claim`, {
    body: JSON.stringify({ due_at: dueAt, risk_level: riskLevel }),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `review-claim-${crypto.randomUUID()}`,
      'if-match': `"${version}"`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  if (!response.ok) throw new ReviewInboxRequestError(response.status);
  const parsed = ReviewClaimResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new ReviewInboxRequestError(502);
  return parsed.data.data;
}

export class ReviewInboxRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Review inbox request failed');
    this.name = 'ReviewInboxRequestError';
  }
}
