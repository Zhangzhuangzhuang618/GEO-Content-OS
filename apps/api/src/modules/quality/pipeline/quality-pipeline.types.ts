import type { BrandProfile, ContentVariantStatus, PlatformCode } from '@geo-content-os/contracts';
import type {
  QualityCheckerData,
  QualityDecision,
  QualityGeoScores,
  QualityIssue,
} from '@geo-content-os/contracts/skills';

export interface QualityPipelineScope {
  readonly generationRunId: string;
  readonly projectId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly variantId: string;
  readonly workspaceId: string;
}

export interface QualityDuplicateMatch {
  readonly content_version_id: string;
  readonly excerpt: string | null;
  readonly similarity: number;
}

export interface QualityPlatformRules {
  readonly platform_code: PlatformCode;
  readonly rules: Readonly<Record<string, unknown>>;
  readonly rules_hash: string;
  readonly version_id: string;
}

export interface QualitySafetyPolicy {
  readonly block_on_data_leakage: boolean;
  readonly block_on_injection: boolean;
  readonly max_warnings_for_pass: number;
}

export interface QualityPipelineRequest {
  readonly brandProfileId: string;
  readonly checkerVersion: string;
  readonly contentVersionId: string;
  readonly duplicateMatches: readonly QualityDuplicateMatch[];
  readonly expectedVariantVersion: number;
  readonly factCheckGenerationRunId: string;
  readonly geoScores: QualityGeoScores;
  readonly platformRules: QualityPlatformRules;
  readonly requestId: string;
  readonly safetyPolicy: QualitySafetyPolicy;
  readonly signal?: AbortSignal;
}

export interface QualityFactInput {
  readonly citation_ids: readonly string[];
  readonly claim_key: string;
  readonly claim_text: string;
  readonly confidence: number;
  readonly risk_level: 'low' | 'medium' | 'high' | 'critical';
  readonly verdict: 'supported' | 'partially_supported' | 'conflicted' | 'unsupported' | 'outdated';
}

export interface QualityContentInput {
  readonly content: Readonly<Record<string, unknown>>;
  readonly content_hash: string;
  readonly content_version_id: string;
  readonly variant_id: string;
}

export interface QualityBrandInput {
  readonly brand_profile_id: string;
  readonly policy: BrandProfile;
  readonly version: number;
}

export interface QualityEvaluationInput {
  readonly brand_policy: QualityBrandInput;
  readonly content_version: QualityContentInput;
  readonly duplicate_matches: readonly QualityDuplicateMatch[];
  readonly fact_results: readonly QualityFactInput[];
  readonly geo_result: Readonly<{ scores: QualityGeoScores }>;
  readonly platform_rules: QualityPlatformRules;
  readonly safety_policy: QualitySafetyPolicy;
}

export interface QualityEvaluatorPort {
  evaluate(input: {
    readonly input: QualityEvaluationInput;
    readonly requestId: string;
    readonly signal?: AbortSignal;
  }): Promise<QualityCheckerData>;
}

export interface LoadedQualityContext {
  readonly brandProfile: QualityBrandInput;
  readonly content: QualityContentInput;
  readonly factResults: readonly QualityFactInput[];
  readonly generationRunVersion: number;
  readonly platformCode: PlatformCode;
  readonly variantStatus: ContentVariantStatus;
  readonly variantVersion: number;
}

export interface QualityReportView {
  readonly checkerVersion: string;
  readonly contentVersionId: string;
  readonly createdAt: Date;
  readonly decision: QualityDecision;
  readonly generationRunId: string;
  readonly geoScores: QualityGeoScores;
  readonly id: string;
  readonly issues: readonly QualityIssue[];
  readonly score: number;
  readonly tenantId: string;
  readonly variantId: string;
  readonly variantStatus: ContentVariantStatus;
  readonly variantVersion: number;
}

export interface PreparedQualityReport {
  readonly checkerVersion: string;
  readonly contentVersionId: string;
  readonly decision: QualityDecision;
  readonly expectedGenerationRunVersion: number;
  readonly expectedVariantVersion: number;
  readonly geoScores: QualityGeoScores;
  readonly issues: readonly QualityIssue[];
  readonly requestId: string;
  readonly score: number;
}
