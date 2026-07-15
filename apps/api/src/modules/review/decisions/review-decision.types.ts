import type { TenantRoleCode } from '@geo-content-os/contracts';

import type { ReviewSnapshotView } from '../repositories/index.js';

export interface ReviewDecisionScope {
  readonly ip?: string | null;
  readonly projectId: string;
  readonly requestId: string;
  readonly supportAccessGrantId?: string | null;
  readonly tenantId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

export interface ReviewDecisionRequest {
  readonly comment?: string | null;
  readonly expectedVersion: number;
  readonly variantIds: readonly string[];
}

export interface RequestReviewSignoffRequest {
  readonly comment?: string | null;
  readonly expectedVersion: number;
  readonly requiredRole?: TenantRoleCode;
  readonly requiredUserId?: string;
  readonly variantIds: readonly string[];
}

export interface ReviewDecisionResult {
  readonly snapshot: ReviewSnapshotView;
}
