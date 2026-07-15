import type { PlatformCode } from '@geo-content-os/contracts';

import type { ReviewSnapshotView } from '../repositories/index.js';

export interface SubmitReviewScope {
  readonly ip?: string | null;
  readonly projectId: string;
  readonly requestId: string;
  readonly supportAccessGrantId?: string | null;
  readonly tenantId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

export interface SubmitReviewRequest {
  readonly packageId: string;
  readonly variantIds: readonly string[];
}

export interface SubmitReviewResult {
  readonly replayed: boolean;
  readonly snapshot: ReviewSnapshotView;
}

export interface FrozenCitationMaterial {
  readonly aiCitationId: string;
  readonly citationHash: string;
}

export interface FrozenPlatformRuleMaterial {
  readonly contentHash: string;
  readonly platformCode: PlatformCode;
  readonly versionId: string;
}

export interface FrozenVariantMaterial {
  readonly citations: readonly FrozenCitationMaterial[];
  readonly contentHash: string;
  readonly contentVersionId: string;
  readonly platformCode: PlatformCode;
  readonly platformRuleVersionId: string;
  readonly qualityReportId: string;
  readonly variantId: string;
}

export interface FrozenSnapshotMaterial {
  readonly brandProfileHash: string;
  readonly brandProfileId: string;
  readonly modelKey: string;
  readonly platformRules: readonly FrozenPlatformRuleMaterial[];
  readonly platformRulesHash: string;
  readonly promptContentHash: string;
  readonly promptVersionId: string;
  readonly qualityRulesHash: string;
  readonly variants: readonly FrozenVariantMaterial[];
}
