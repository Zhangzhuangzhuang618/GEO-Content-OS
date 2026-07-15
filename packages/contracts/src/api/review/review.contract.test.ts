import { describe, expect, it } from 'vitest';

import {
  REVIEW_API_CONTRACTS,
  REVIEW_OPENAPI_DOCUMENT,
  RequestSignoffRequestSchema,
  ReviewDecisionRequestSchema,
  SubmitReviewRequestSchema,
} from './index.js';

const EXPECTED = [
  [
    'POST',
    '/content-packages/{id}/submit-review',
    'content_editor_or_admin',
    'SubmitReviewRequest',
    'ReviewSnapshotView',
    'key+snapshot_hash',
    201,
  ],
  [
    'GET',
    '/review-snapshots',
    'reviewer_or_admin',
    'ReviewInboxQuery',
    'ReviewSnapshotPage',
    '-',
    200,
  ],
  ['GET', '/review-snapshots/{id}', 'reviewer_or_admin', '-', 'ReviewSnapshotDetail', '-', 200],
  [
    'POST',
    '/review-snapshots/{id}/approve',
    'reviewer_or_admin',
    'ReviewDecisionRequest',
    'ReviewSnapshotDetail',
    'key+version',
    200,
  ],
  [
    'POST',
    '/review-snapshots/{id}/reject',
    'reviewer_or_admin',
    'ReviewDecisionRequest',
    'ReviewSnapshotDetail',
    'key+version',
    200,
  ],
  [
    'POST',
    '/review-snapshots/{id}/request-signoff',
    'reviewer_or_admin',
    'RequestSignoffRequest',
    'ReviewRequirementView',
    'key+version',
    201,
  ],
  ['GET', '/review-snapshots/{id}/actions', 'tenant_member', '-', 'ReviewAction[]', '-', 200],
] as const;

describe('Review API frozen contract', () => {
  it('matches all seven frozen endpoints exactly', () => {
    expect(REVIEW_API_CONTRACTS).toHaveLength(7);
    expect(
      REVIEW_API_CONTRACTS.map((item) => [
        item.method,
        item.path,
        item.policy,
        item.requestName,
        item.responseName,
        item.idempotency,
        item.successStatus,
      ]),
    ).toEqual(EXPECTED);
    expect(new Set(REVIEW_API_CONTRACTS.map((item) => `${item.method} ${item.path}`)).size).toBe(7);
  });

  it('projects all operations into OpenAPI 3.1 with frozen guards', () => {
    expect(REVIEW_OPENAPI_DOCUMENT.openapi).toBe('3.1.0');
    const operations = Object.values(REVIEW_OPENAPI_DOCUMENT.paths).flatMap((path) =>
      Object.values(path),
    );
    expect(operations).toHaveLength(7);
    for (const contract of REVIEW_API_CONTRACTS) {
      const operation = REVIEW_OPENAPI_DOCUMENT.paths[contract.path]?.[
        contract.method.toLowerCase()
      ] as Record<string, unknown>;
      expect(operation['x-idempotency']).toBe(contract.idempotency);
      expect(operation['x-permission']).toBe(contract.permission);
      expect(operation['x-policy']).toBe(contract.policy);
    }
  });

  it('keeps tenant context out of write DTOs and enforces subset inputs', () => {
    expect(
      SubmitReviewRequestSchema.safeParse({
        tenant_id: crypto.randomUUID(),
        variant_ids: [crypto.randomUUID()],
      }).success,
    ).toBe(false);
    expect(ReviewDecisionRequestSchema.safeParse({ variant_ids: [] }).success).toBe(false);
    expect(
      RequestSignoffRequestSchema.safeParse({
        required_role: 'reviewer',
        required_user_id: crypto.randomUUID(),
        variant_id: crypto.randomUUID(),
      }).success,
    ).toBe(false);
  });
});
