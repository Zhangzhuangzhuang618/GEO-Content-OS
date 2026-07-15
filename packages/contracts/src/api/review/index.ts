import type { PermissionCode, PolicyCode } from '../../permissions/index.js';
import type { z } from 'zod';

import { buildReviewOpenApiDocument } from './openapi.js';
import {
  ClaimReviewRequestSchema,
  RequestSignoffRequestSchema,
  ReviewActionPageSchema,
  ReviewClaimResponseSchema,
  ReviewDecisionRequestSchema,
  ReviewInboxQuerySchema,
  ReviewRequirementResponseSchema,
  ReviewSnapshotDetailResponseSchema,
  ReviewSnapshotPageSchema,
  ReviewSnapshotParamsSchema,
  ReviewSnapshotResponseSchema,
  SubmitReviewRequestSchema,
} from './schemas.js';

export * from './openapi.js';
export * from './schemas.js';

export interface ReviewApiContract {
  readonly bodySchema: z.ZodType | null;
  readonly idempotency: '-' | 'key+snapshot_hash' | 'key+version';
  readonly key: string;
  readonly method: 'GET' | 'POST';
  readonly paramsSchema: z.ZodType | null;
  readonly path: string;
  readonly permission: Extract<
    PermissionCode,
    'content.production.manage' | 'review.decide' | 'review.read'
  >;
  readonly policy: Extract<
    PolicyCode,
    'content_editor_or_admin' | 'reviewer_or_admin' | 'tenant_member'
  >;
  readonly querySchema: z.ZodType | null;
  readonly requestName: string;
  readonly responseName: string;
  readonly responseSchema: z.ZodType;
  readonly successStatus: 200 | 201;
}

const contracts = [
  contract(
    'review.submit',
    'POST',
    '/content-packages/{id}/submit-review',
    'content_editor_or_admin',
    'content.production.manage',
    'key+snapshot_hash',
    SubmitReviewRequestSchema,
    'SubmitReviewRequest',
    'ReviewSnapshotView',
    ReviewSnapshotResponseSchema,
    201,
  ),
  contract(
    'review.list',
    'GET',
    '/review-snapshots',
    'reviewer_or_admin',
    'review.decide',
    '-',
    null,
    'ReviewInboxQuery',
    'ReviewSnapshotPage',
    ReviewSnapshotPageSchema,
    200,
    ReviewInboxQuerySchema,
  ),
  contract(
    'review.get',
    'GET',
    '/review-snapshots/{id}',
    'reviewer_or_admin',
    'review.decide',
    '-',
    null,
    '-',
    'ReviewSnapshotDetail',
    ReviewSnapshotDetailResponseSchema,
    200,
  ),
  contract(
    'review.claim',
    'POST',
    '/review-snapshots/{id}/claim',
    'reviewer_or_admin',
    'review.decide',
    'key+version',
    ClaimReviewRequestSchema,
    'ClaimReviewRequest',
    'ReviewClaimView',
    ReviewClaimResponseSchema,
    200,
  ),
  contract(
    'review.approve',
    'POST',
    '/review-snapshots/{id}/approve',
    'reviewer_or_admin',
    'review.decide',
    'key+version',
    ReviewDecisionRequestSchema,
    'ReviewDecisionRequest',
    'ReviewSnapshotDetail',
    ReviewSnapshotDetailResponseSchema,
    200,
  ),
  contract(
    'review.reject',
    'POST',
    '/review-snapshots/{id}/reject',
    'reviewer_or_admin',
    'review.decide',
    'key+version',
    ReviewDecisionRequestSchema,
    'ReviewDecisionRequest',
    'ReviewSnapshotDetail',
    ReviewSnapshotDetailResponseSchema,
    200,
  ),
  contract(
    'review.request-signoff',
    'POST',
    '/review-snapshots/{id}/request-signoff',
    'reviewer_or_admin',
    'review.decide',
    'key+version',
    RequestSignoffRequestSchema,
    'RequestSignoffRequest',
    'ReviewRequirementView',
    ReviewRequirementResponseSchema,
    201,
  ),
  contract(
    'review.actions',
    'GET',
    '/review-snapshots/{id}/actions',
    'tenant_member',
    'review.read',
    '-',
    null,
    '-',
    'ReviewAction[]',
    ReviewActionPageSchema,
    200,
  ),
] as const satisfies readonly ReviewApiContract[];

export const REVIEW_API_CONTRACTS: readonly ReviewApiContract[] = Object.freeze(contracts);
export type ReviewApiContractKey = (typeof contracts)[number]['key'];
export const REVIEW_OPENAPI_DOCUMENT = buildReviewOpenApiDocument(REVIEW_API_CONTRACTS);

export function findReviewApiContract(key: ReviewApiContractKey): ReviewApiContract {
  const found = contracts.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`Unknown Review API contract: ${key}`);
  return found;
}

function contract(
  key: string,
  method: ReviewApiContract['method'],
  path: string,
  policy: ReviewApiContract['policy'],
  permission: ReviewApiContract['permission'],
  idempotency: ReviewApiContract['idempotency'],
  bodySchema: z.ZodType | null,
  requestName: string,
  responseName: string,
  responseSchema: z.ZodType,
  successStatus: ReviewApiContract['successStatus'],
  querySchema: z.ZodType | null = null,
): ReviewApiContract {
  return {
    bodySchema,
    idempotency,
    key,
    method,
    paramsSchema: path.includes('{id}') ? ReviewSnapshotParamsSchema : null,
    path,
    permission,
    policy,
    querySchema,
    requestName,
    responseName,
    responseSchema,
    successStatus,
  };
}
