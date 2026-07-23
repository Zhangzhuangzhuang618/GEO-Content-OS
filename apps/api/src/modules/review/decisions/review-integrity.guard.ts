import type { PlatformCode } from '@geo-content-os/contracts';
import type { TransactionSql } from 'postgres';

import type { JsonValue } from '../../../common/idempotency/index.js';
import {
  calculateCitationHash,
  calculatePlatformRulesHash,
  calculateQualityRulesHash,
  calculateSnapshotHash,
  hashCanonical,
} from '../submit/index.js';
import type {
  FrozenCitationMaterial,
  FrozenPlatformRuleMaterial,
  FrozenSnapshotMaterial,
  FrozenVariantMaterial,
} from '../submit/index.js';
import { ReviewDecisionError } from './review-decision.errors.js';

export interface IntegritySnapshot {
  readonly brandProfileId: string;
  readonly id: string;
  readonly modelKey: string;
  readonly platformRulesHash: string;
  readonly promptVersionId: string;
  readonly qualityRulesHash: string;
  readonly snapshotHash: string;
  readonly tenantId: string;
}

interface IntegrityVariantRow {
  readonly checkerVersion: string;
  readonly contentHash: string;
  readonly contentVersionId: string;
  readonly currentContentVersionId: string | null;
  readonly modelKey: string;
  readonly platformCode: PlatformCode;
  readonly platformRuleContentHash: string;
  readonly platformRulePlatformCode: PlatformCode;
  readonly platformRuleVersionId: string;
  readonly promptContentHash: string;
  readonly promptVersionId: string;
  readonly qualityReportId: string;
  readonly snapshotContentHash: string;
  readonly snapshotVariantId: string;
  readonly variantId: string;
}

interface BrandRow {
  readonly profile: JsonValue;
  readonly schemaVersion: string;
  readonly version: number;
}

interface CitationRow {
  readonly aiCitationId: string;
  readonly claimKey: string;
  readonly claimText: string;
  readonly chunkId: string;
  readonly contentVersionId: string;
  readonly quoteHash: string;
  readonly quoteText: string;
  readonly snapshotVariantId: string;
}

interface FrozenCitationRow {
  readonly aiCitationId: string;
  readonly citationHash: string;
  readonly snapshotVariantId: string;
}

export async function assertReviewSnapshotIntegrity(
  transaction: TransactionSql,
  snapshot: IntegritySnapshot,
): Promise<void> {
  const variants = await loadIntegrityVariants(transaction, snapshot);
  if (variants.length === 0) integrityConflict();
  const brand = await loadBrand(transaction, snapshot);
  if (!brand) integrityConflict();
  assertVariantReferences(snapshot, variants);

  const currentCitations = await loadCurrentCitations(transaction, snapshot, variants);
  const frozenCitations = await loadFrozenCitations(transaction, snapshot);
  assertCitationSet(currentCitations, frozenCitations);

  const platformRules = uniquePlatformRules(variants);
  const material: FrozenSnapshotMaterial = Object.freeze({
    brandProfileHash: hashCanonical({
      profile: brand.profile,
      schema_version: brand.schemaVersion,
      version: brand.version,
    }),
    brandProfileId: snapshot.brandProfileId,
    modelKey: snapshot.modelKey,
    platformRules,
    platformRulesHash: calculatePlatformRulesHash(platformRules),
    promptContentHash: variants[0]!.promptContentHash,
    promptVersionId: snapshot.promptVersionId,
    qualityRulesHash: calculateQualityRulesHash(variants.map((row) => row.checkerVersion)),
    variants: Object.freeze(
      variants.map((row) =>
        Object.freeze({
          citations: Object.freeze(
            currentCitations
              .filter((citation) => citation.snapshotVariantId === row.snapshotVariantId)
              .map(toFrozenCitation),
          ),
          contentHash: row.contentHash,
          contentVersionId: row.contentVersionId,
          platformCode: row.platformCode,
          platformRuleVersionId: row.platformRuleVersionId,
          qualityReportId: row.qualityReportId,
          variantId: row.variantId,
        } satisfies FrozenVariantMaterial),
      ),
    ),
  });

  if (
    material.platformRulesHash !== snapshot.platformRulesHash ||
    material.qualityRulesHash !== snapshot.qualityRulesHash ||
    calculateSnapshotHash(material) !== snapshot.snapshotHash
  ) {
    integrityConflict();
  }
}

async function loadIntegrityVariants(
  transaction: TransactionSql,
  snapshot: IntegritySnapshot,
): Promise<readonly IntegrityVariantRow[]> {
  return transaction<IntegrityVariantRow[]>`
    SELECT
      snapshot_variant.id AS "snapshotVariantId",
      snapshot_variant.variant_id AS "variantId",
      snapshot_variant.content_version_id AS "contentVersionId",
      snapshot_variant.content_hash AS "snapshotContentHash",
      snapshot_variant.platform_rule_version_id AS "platformRuleVersionId",
      snapshot_variant.quality_report_id AS "qualityReportId",
      variant.platform_code AS "platformCode",
      variant.current_content_version_id AS "currentContentVersionId",
      content_version.content_hash AS "contentHash",
      quality_report.checker_version AS "checkerVersion",
      generation_run.prompt_version_id AS "promptVersionId",
      generation_run.model_key AS "modelKey",
      prompt.content_hash AS "promptContentHash",
      platform_rule.platform_code AS "platformRulePlatformCode",
      platform_rule.content_hash AS "platformRuleContentHash"
    FROM review_snapshot_variants AS snapshot_variant
    JOIN content_variants AS variant
      ON variant.id = snapshot_variant.variant_id
      AND variant.tenant_id = snapshot_variant.tenant_id
    JOIN content_versions AS content_version
      ON content_version.id = snapshot_variant.content_version_id
      AND content_version.tenant_id = snapshot_variant.tenant_id
      AND content_version.variant_id = snapshot_variant.variant_id
    JOIN quality_reports AS quality_report
      ON quality_report.id = snapshot_variant.quality_report_id
      AND quality_report.tenant_id = snapshot_variant.tenant_id
      AND quality_report.variant_id = snapshot_variant.variant_id
      AND quality_report.content_version_id = snapshot_variant.content_version_id
      AND quality_report.decision = 'pass'
    JOIN generation_runs AS generation_run
      ON generation_run.id = quality_report.generation_run_id
      AND generation_run.tenant_id = snapshot_variant.tenant_id
      AND generation_run.variant_id = snapshot_variant.variant_id
      AND generation_run.skill_name = 'quality-checker'
      AND generation_run.status = 'succeeded'
    JOIN prompt_versions AS prompt ON prompt.id = generation_run.prompt_version_id
    JOIN platform_rule_versions AS platform_rule
      ON platform_rule.id = snapshot_variant.platform_rule_version_id
    WHERE snapshot_variant.tenant_id = ${snapshot.tenantId}::uuid
      AND snapshot_variant.snapshot_id = ${snapshot.id}::uuid
    ORDER BY snapshot_variant.variant_id
  `;
}

async function loadBrand(
  transaction: TransactionSql,
  snapshot: IntegritySnapshot,
): Promise<BrandRow | undefined> {
  const rows = await transaction<BrandRow[]>`
    SELECT version, schema_version AS "schemaVersion", profile_json AS profile
    FROM brand_profiles
    WHERE tenant_id = ${snapshot.tenantId}::uuid
      AND id = ${snapshot.brandProfileId}::uuid
    LIMIT 1
  `;
  return rows[0];
}

async function loadCurrentCitations(
  transaction: TransactionSql,
  snapshot: IntegritySnapshot,
  variants: readonly IntegrityVariantRow[],
): Promise<readonly CitationRow[]> {
  return transaction<CitationRow[]>`
    SELECT
      snapshot_variant.id AS "snapshotVariantId",
      citation.id AS "aiCitationId",
      citation.content_version_id AS "contentVersionId",
      citation.claim_key AS "claimKey",
      citation.claim_text AS "claimText",
      citation.chunk_id AS "chunkId",
      citation.quote_text AS "quoteText",
      citation.quote_hash AS "quoteHash"
    FROM review_snapshot_variants AS snapshot_variant
    JOIN ai_citations AS citation
      ON citation.tenant_id = snapshot_variant.tenant_id
      AND citation.content_version_id = snapshot_variant.content_version_id
    WHERE snapshot_variant.tenant_id = ${snapshot.tenantId}::uuid
      AND snapshot_variant.snapshot_id = ${snapshot.id}::uuid
      AND snapshot_variant.content_version_id = ANY(
        ${variants.map((variant) => variant.contentVersionId)}::uuid[]
      )
    ORDER BY snapshot_variant.id, citation.id
  `;
}

async function loadFrozenCitations(
  transaction: TransactionSql,
  snapshot: IntegritySnapshot,
): Promise<readonly FrozenCitationRow[]> {
  return transaction<FrozenCitationRow[]>`
    SELECT
      frozen.snapshot_variant_id AS "snapshotVariantId",
      frozen.ai_citation_id AS "aiCitationId",
      frozen.citation_hash AS "citationHash"
    FROM review_snapshot_citations AS frozen
    JOIN review_snapshot_variants AS snapshot_variant
      ON snapshot_variant.id = frozen.snapshot_variant_id
      AND snapshot_variant.tenant_id = frozen.tenant_id
    WHERE frozen.tenant_id = ${snapshot.tenantId}::uuid
      AND snapshot_variant.snapshot_id = ${snapshot.id}::uuid
    ORDER BY frozen.snapshot_variant_id, frozen.ai_citation_id
  `;
}

function assertVariantReferences(
  snapshot: IntegritySnapshot,
  variants: readonly IntegrityVariantRow[],
): void {
  if (
    variants.some(
      (row) =>
        row.currentContentVersionId !== row.contentVersionId ||
        row.contentHash !== row.snapshotContentHash ||
        row.platformCode !== row.platformRulePlatformCode ||
        row.promptVersionId !== snapshot.promptVersionId ||
        row.modelKey !== snapshot.modelKey,
    )
  ) {
    integrityConflict();
  }
  const promptHashes = new Set(variants.map((row) => row.promptContentHash));
  if (promptHashes.size !== 1) integrityConflict();
}

function assertCitationSet(
  current: readonly CitationRow[],
  frozen: readonly FrozenCitationRow[],
): void {
  const currentSet = current.map((citation) => ({
    aiCitationId: citation.aiCitationId,
    citationHash: calculateCitationHash(citation),
    snapshotVariantId: citation.snapshotVariantId,
  }));
  if (currentSet.length !== frozen.length) integrityConflict();
  for (let index = 0; index < currentSet.length; index += 1) {
    const actual = currentSet[index]!;
    const expected = frozen[index]!;
    if (
      actual.snapshotVariantId !== expected.snapshotVariantId ||
      actual.aiCitationId !== expected.aiCitationId ||
      actual.citationHash !== expected.citationHash
    ) {
      integrityConflict();
    }
  }
}

function uniquePlatformRules(
  variants: readonly IntegrityVariantRow[],
): readonly FrozenPlatformRuleMaterial[] {
  const rules = new Map<string, FrozenPlatformRuleMaterial>();
  for (const variant of variants) {
    const current = rules.get(variant.platformRuleVersionId);
    const next = Object.freeze({
      contentHash: variant.platformRuleContentHash,
      platformCode: variant.platformCode,
      versionId: variant.platformRuleVersionId,
    });
    if (current && current.platformCode !== next.platformCode) integrityConflict();
    rules.set(next.versionId, next);
  }
  return Object.freeze([...rules.values()]);
}

function toFrozenCitation(citation: CitationRow): FrozenCitationMaterial {
  return Object.freeze({
    aiCitationId: citation.aiCitationId,
    citationHash: calculateCitationHash(citation),
  });
}

function integrityConflict(): never {
  throw new ReviewDecisionError(
    'REVIEW_DECISION_VERSION_CONFLICT',
    'The review snapshot no longer matches its frozen content and configuration',
  );
}
