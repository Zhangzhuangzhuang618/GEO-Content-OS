import { createHash } from 'node:crypto';

import { canonicalJson, type JsonValue } from '../../../common/idempotency/index.js';
import type {
  FrozenCitationMaterial,
  FrozenPlatformRuleMaterial,
  FrozenSnapshotMaterial,
  FrozenVariantMaterial,
} from './submit-review.types.js';

export function calculateSnapshotHash(material: FrozenSnapshotMaterial): string {
  return hashCanonical({
    brand_profile_hash: material.brandProfileHash,
    brand_profile_id: material.brandProfileId,
    model_key: material.modelKey,
    platform_rules: sortPlatformRules(material.platformRules).map((rule) => ({
      content_hash: rule.contentHash,
      platform_code: rule.platformCode,
      version_id: rule.versionId,
    })),
    platform_rules_hash: material.platformRulesHash,
    prompt_content_hash: material.promptContentHash,
    prompt_version_id: material.promptVersionId,
    quality_rules_hash: material.qualityRulesHash,
    schema_version: 'review-snapshot@1',
    variants: sortVariants(material.variants).map((variant) => ({
      citations: sortCitations(variant.citations).map((citation) => ({
        ai_citation_id: citation.aiCitationId,
        citation_hash: citation.citationHash,
      })),
      content_hash: variant.contentHash,
      content_version_id: variant.contentVersionId,
      platform_code: variant.platformCode,
      platform_rule_version_id: variant.platformRuleVersionId,
      quality_report_id: variant.qualityReportId,
      variant_id: variant.variantId,
    })),
  });
}

export function calculateCitationHash(input: {
  readonly claimKey: string;
  readonly claimText: string;
  readonly chunkId: string;
  readonly contentVersionId: string;
  readonly quoteHash: string;
  readonly quoteText: string;
}): string {
  return hashCanonical({
    claim_key: input.claimKey,
    claim_text: input.claimText,
    chunk_id: input.chunkId,
    content_version_id: input.contentVersionId,
    quote_hash: input.quoteHash,
    quote_text: input.quoteText,
    schema_version: 'review-citation@1',
  });
}

export function calculatePlatformRulesHash(rules: readonly FrozenPlatformRuleMaterial[]): string {
  return hashCanonical({
    rules: sortPlatformRules(rules).map((rule) => ({
      content_hash: rule.contentHash,
      platform_code: rule.platformCode,
      version_id: rule.versionId,
    })),
    schema_version: 'review-platform-rules@1',
  });
}

export function calculateQualityRulesHash(checkerVersions: readonly string[]): string {
  return hashCanonical({
    checker_versions: [...new Set(checkerVersions)].sort(),
    schema_version: 'review-quality-rules@1',
  });
}

export function hashCanonical(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function sortCitations(
  citations: readonly FrozenCitationMaterial[],
): readonly FrozenCitationMaterial[] {
  return [...citations].sort((left, right) => compareText(left.aiCitationId, right.aiCitationId));
}

function sortPlatformRules(
  rules: readonly FrozenPlatformRuleMaterial[],
): readonly FrozenPlatformRuleMaterial[] {
  return [...rules].sort((left, right) => compareText(left.platformCode, right.platformCode));
}

function sortVariants(
  variants: readonly FrozenVariantMaterial[],
): readonly FrozenVariantMaterial[] {
  return [...variants].sort((left, right) => compareText(left.variantId, right.variantId));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
