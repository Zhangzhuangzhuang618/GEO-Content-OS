import {
  type ContentPackageStatus,
  type ContentVariantStatus,
  type PlatformCode,
  UuidSchema,
} from '@geo-content-os/contracts';
import type { TransactionSql } from 'postgres';

import type { JsonValue } from '../../../common/idempotency/index.js';
import type { DatabaseClient } from '../../../database/index.js';
import { RequiredAuditWriter } from '../../audit/index.js';
import { PackageStatusProjector } from '../../content/status/index.js';
import {
  ReviewRepository,
  type CreateReviewSnapshotInput,
  type ReviewScope,
  type ReviewSnapshotView,
} from '../repositories/index.js';
import { SubmitReviewError } from './submit-review.errors.js';
import {
  calculateCitationHash,
  calculatePlatformRulesHash,
  calculateQualityRulesHash,
  calculateSnapshotHash,
  hashCanonical,
} from './snapshot-hash.js';
import type {
  FrozenCitationMaterial,
  FrozenPlatformRuleMaterial,
  FrozenSnapshotMaterial,
  FrozenVariantMaterial,
  SubmitReviewRequest,
  SubmitReviewResult,
  SubmitReviewScope,
} from './submit-review.types.js';

interface PackageRow {
  readonly id: string;
  readonly status: ContentPackageStatus;
  readonly version: number;
}

interface BrandRow {
  readonly id: string;
  readonly profile: JsonValue;
  readonly schemaVersion: string;
  readonly version: number;
}

interface SubmissionVariantRow {
  readonly checkerVersion: string;
  readonly contentHash: string;
  readonly contentVersionId: string;
  readonly isRequired: boolean;
  readonly modelKey: string;
  readonly platformCode: PlatformCode;
  readonly promptContentHash: string;
  readonly promptSkillName: string;
  readonly promptStatus: 'draft' | 'published' | 'retired';
  readonly promptVersionId: string;
  readonly qualityReportId: string;
  readonly status: ContentVariantStatus;
  readonly variantId: string;
  readonly version: number;
}

interface PlatformRuleRow extends FrozenPlatformRuleMaterial {
  readonly status: 'draft' | 'published' | 'retired';
}

interface CitationRow {
  readonly aiCitationId: string;
  readonly claimKey: string;
  readonly claimText: string;
  readonly chunkId: string;
  readonly contentVersionId: string;
  readonly quoteHash: string;
  readonly quoteText: string;
}

interface ProjectionRow {
  readonly isRequired: boolean;
  readonly status: ContentVariantStatus;
}

export class SubmitReviewService {
  private readonly projector = new PackageStatusProjector();

  public constructor(
    private readonly client: DatabaseClient,
    private readonly repository: ReviewRepository = new ReviewRepository(client),
    private readonly auditWriter: RequiredAuditWriter = new RequiredAuditWriter(),
  ) {}

  public async submit(
    scope: SubmitReviewScope,
    request: SubmitReviewRequest,
    providedTransaction?: TransactionSql,
  ): Promise<SubmitReviewResult> {
    const variantIds = validateRequest(scope, request);
    const reviewScope: ReviewScope = {
      projectId: scope.projectId,
      tenantId: scope.tenantId,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
    };
    const work = async (transaction: TransactionSql): Promise<SubmitReviewResult> => {
      const packageRow = await lockPackage(transaction, scope, request.packageId);
      if (!packageRow) notFound();
      if (packageRow.status === 'archived' || packageRow.status === 'cancelled') {
        stateInvalid('Archived or cancelled packages cannot be submitted for review');
      }

      const rows = await loadVariants(transaction, scope, request.packageId, variantIds);
      if (rows.length !== variantIds.length) {
        const scopedVariantCount = await countScopedVariants(
          transaction,
          scope.tenantId,
          request.packageId,
          variantIds,
        );
        if (scopedVariantCount !== variantIds.length) notFound();
        stateInvalid('Every selected variant requires a current passing quality report');
      }
      const brand = await loadPublishedBrand(transaction, scope);
      if (!brand) stateInvalid('A published Brand Profile is required');
      const platformRules = await loadPublishedPlatformRules(
        transaction,
        rows.map((row) => row.platformCode),
      );
      const material = await buildFrozenMaterial(
        transaction,
        scope.tenantId,
        rows,
        brand,
        platformRules,
      );
      const snapshotHash = calculateSnapshotHash(material);
      const existing = await findExistingSnapshot(
        transaction,
        reviewScope,
        request.packageId,
        snapshotHash,
        this.repository,
      );
      if (existing) return Object.freeze({ replayed: true, snapshot: existing });

      if (rows.some((row) => row.status !== 'quality_passed')) {
        stateInvalid('Only quality_passed variants may be submitted for review');
      }
      const snapshotInput = toSnapshotInput(request.packageId, snapshotHash, material);
      const snapshotId = await this.repository.insertSnapshot(
        transaction,
        reviewScope,
        snapshotInput,
      );
      await transitionVariants(transaction, scope.tenantId, rows);
      const projectedStatus = await projectPackageStatus(
        transaction,
        scope.tenantId,
        request.packageId,
        packageRow.status,
        this.projector,
      );
      const packageUpdated = await transaction<{ id: string }[]>`
        UPDATE content_packages
        SET status = ${projectedStatus}, version = version + 1
        WHERE id = ${request.packageId}::uuid
          AND tenant_id = ${scope.tenantId}::uuid
          AND version = ${packageRow.version}
        RETURNING id
      `;
      if (packageUpdated.length !== 1) versionConflict();
      await this.auditWriter.record(transaction, {
        action: 'review_snapshot.submitted',
        actorId: scope.userId,
        after: {
          package_status: projectedStatus,
          snapshot_hash: snapshotHash,
          snapshot_id: snapshotId,
          variant_ids: variantIds,
        },
        before: { package_status: packageRow.status },
        ip: scope.ip ?? null,
        requestId: scope.requestId,
        resourceId: snapshotId,
        resourceType: 'review_snapshot',
        supportAccessGrantId: scope.supportAccessGrantId ?? null,
        tenantId: scope.tenantId,
      });
      const snapshot = await this.repository.findSnapshot(reviewScope, snapshotId, transaction);
      if (!snapshot)
        throw new Error('Submitted review snapshot is not readable in its transaction');
      return Object.freeze({ replayed: false, snapshot });
    };
    return providedTransaction ? work(providedTransaction) : this.repository.withTransaction(work);
  }
}

function validateRequest(
  scope: SubmitReviewScope,
  request: SubmitReviewRequest,
): readonly string[] {
  const scopeIds = [
    scope.projectId,
    scope.tenantId,
    scope.userId,
    scope.workspaceId,
    request.packageId,
  ];
  if (scopeIds.some((value) => !UuidSchema.safeParse(value).success)) {
    inputInvalid('Review scope and package IDs must be UUIDs');
  }
  if (scope.requestId.trim().length < 1 || scope.requestId.trim().length > 80) {
    inputInvalid('requestId must contain 1 to 80 characters');
  }
  if (request.variantIds.length < 1 || request.variantIds.length > 8) {
    inputInvalid('variantIds must contain between 1 and 7 items');
  }
  if (request.variantIds.some((value) => !UuidSchema.safeParse(value).success)) {
    inputInvalid('Every variant ID must be a UUID');
  }
  const unique = [...new Set(request.variantIds)];
  if (unique.length !== request.variantIds.length) inputInvalid('variantIds must be unique');
  return unique.sort();
}

async function lockPackage(
  transaction: TransactionSql,
  scope: SubmitReviewScope,
  packageId: string,
): Promise<PackageRow | undefined> {
  const rows = await transaction<PackageRow[]>`
    SELECT package.id, package.status, package.version
    FROM content_packages AS package
    JOIN memberships AS membership
      ON membership.tenant_id = package.tenant_id
      AND membership.user_id = ${scope.userId}::uuid
      AND membership.status = 'active'
      AND membership.role_code IN ('tenant_owner', 'tenant_admin', 'content_editor')
    WHERE package.id = ${packageId}::uuid
      AND package.tenant_id = ${scope.tenantId}::uuid
      AND package.workspace_id = ${scope.workspaceId}::uuid
      AND package.project_id = ${scope.projectId}::uuid
      AND package.deleted_at IS NULL
      AND has_project_scope_access(
        package.tenant_id,
        package.workspace_id,
        package.project_id,
        ${scope.userId}::uuid
      )
    LIMIT 1
    FOR UPDATE OF package
  `;
  return rows[0];
}

async function loadVariants(
  transaction: TransactionSql,
  scope: SubmitReviewScope,
  packageId: string,
  variantIds: readonly string[],
): Promise<readonly SubmissionVariantRow[]> {
  return transaction<SubmissionVariantRow[]>`
    SELECT
      variant.id AS "variantId",
      variant.platform_code AS "platformCode",
      variant.status,
      variant.is_required AS "isRequired",
      variant.version,
      version.id AS "contentVersionId",
      version.content_hash AS "contentHash",
      report.id AS "qualityReportId",
      report.checker_version AS "checkerVersion",
      run.prompt_version_id AS "promptVersionId",
      run.model_key AS "modelKey",
      prompt.content_hash AS "promptContentHash",
      prompt.skill_name AS "promptSkillName",
      prompt.status AS "promptStatus"
    FROM content_variants AS variant
    JOIN content_versions AS version
      ON version.id = variant.current_content_version_id
      AND version.tenant_id = variant.tenant_id
      AND version.package_id = variant.package_id
      AND version.variant_id = variant.id
    JOIN LATERAL (
      SELECT candidate.*
      FROM quality_reports AS candidate
      WHERE candidate.tenant_id = variant.tenant_id
        AND candidate.variant_id = variant.id
        AND candidate.content_version_id = version.id
        AND candidate.decision = 'pass'
      ORDER BY candidate.created_at DESC, candidate.id DESC
      LIMIT 1
    ) AS report ON true
    JOIN generation_runs AS run
      ON run.id = report.generation_run_id
      AND run.tenant_id = report.tenant_id
      AND run.package_id = variant.package_id
      AND run.variant_id = variant.id
      AND run.skill_name = 'quality-checker'
      AND run.status = 'succeeded'
    JOIN prompt_versions AS prompt ON prompt.id = run.prompt_version_id
    WHERE variant.tenant_id = ${scope.tenantId}::uuid
      AND variant.package_id = ${packageId}::uuid
      AND variant.id = ANY(${variantIds}::uuid[])
    ORDER BY variant.id
    FOR UPDATE OF variant
  `;
}

async function countScopedVariants(
  transaction: TransactionSql,
  tenantId: string,
  packageId: string,
  variantIds: readonly string[],
): Promise<number> {
  const rows = await transaction<{ count: number }[]>`
    SELECT count(*)::integer AS count
    FROM content_variants
    WHERE tenant_id = ${tenantId}::uuid
      AND package_id = ${packageId}::uuid
      AND id = ANY(${variantIds}::uuid[])
  `;
  return rows[0]?.count ?? 0;
}

async function loadPublishedBrand(
  transaction: TransactionSql,
  scope: SubmitReviewScope,
): Promise<BrandRow | undefined> {
  const rows = await transaction<BrandRow[]>`
    SELECT id, version, schema_version AS "schemaVersion", profile_json AS profile
    FROM brand_profiles
    WHERE tenant_id = ${scope.tenantId}::uuid
      AND workspace_id = ${scope.workspaceId}::uuid
      AND status = 'published'
    LIMIT 1
  `;
  return rows[0];
}

async function loadPublishedPlatformRules(
  transaction: TransactionSql,
  platformCodes: readonly PlatformCode[],
): Promise<readonly PlatformRuleRow[]> {
  const uniqueCodes = [...new Set(platformCodes)].sort();
  const rows = await transaction<PlatformRuleRow[]>`
    SELECT
      id AS "versionId",
      platform_code AS "platformCode",
      content_hash AS "contentHash",
      status
    FROM platform_rule_versions
    WHERE platform_code = ANY(${uniqueCodes}::varchar[])
      AND status = 'published'
    ORDER BY platform_code, created_at DESC, id DESC
  `;
  if (rows.length !== uniqueCodes.length) {
    stateInvalid('Every selected platform must have exactly one published rule version');
  }
  return rows;
}

async function buildFrozenMaterial(
  transaction: TransactionSql,
  tenantId: string,
  rows: readonly SubmissionVariantRow[],
  brand: BrandRow,
  platformRules: readonly PlatformRuleRow[],
): Promise<FrozenSnapshotMaterial> {
  if (rows.some((row) => row.promptStatus === 'draft')) {
    stateInvalid('Draft Prompt versions cannot be submitted for review');
  }
  if (rows.some((row) => row.promptSkillName !== 'quality-checker')) {
    stateInvalid('Quality reports must reference a quality-checker Prompt version');
  }
  const promptIds = [...new Set(rows.map((row) => row.promptVersionId))];
  const promptHashes = [...new Set(rows.map((row) => row.promptContentHash))];
  const modelKeys = [...new Set(rows.map((row) => row.modelKey))];
  if (promptIds.length !== 1 || promptHashes.length !== 1 || modelKeys.length !== 1) {
    stateInvalid('Selected variants must share one quality Prompt and model configuration');
  }
  const citations = await loadCitations(
    transaction,
    tenantId,
    rows.map((row) => row.contentVersionId),
  );
  const rulesByPlatform = new Map(platformRules.map((rule) => [rule.platformCode, rule]));
  const variants: FrozenVariantMaterial[] = rows.map((row) => {
    const rule = rulesByPlatform.get(row.platformCode);
    if (!rule) stateInvalid(`Published platform rule is missing for ${row.platformCode}`);
    return Object.freeze({
      citations: Object.freeze(
        citations
          .filter((citation) => citation.contentVersionId === row.contentVersionId)
          .map(toFrozenCitation),
      ),
      contentHash: row.contentHash,
      contentVersionId: row.contentVersionId,
      platformCode: row.platformCode,
      platformRuleVersionId: rule.versionId,
      qualityReportId: row.qualityReportId,
      variantId: row.variantId,
    });
  });
  const frozenRules = platformRules.map((rule) =>
    Object.freeze({
      contentHash: rule.contentHash,
      platformCode: rule.platformCode,
      versionId: rule.versionId,
    }),
  );
  return Object.freeze({
    brandProfileHash: hashCanonical({
      profile: brand.profile,
      schema_version: brand.schemaVersion,
      version: brand.version,
    }),
    brandProfileId: brand.id,
    modelKey: modelKeys[0]!,
    platformRules: Object.freeze(frozenRules),
    platformRulesHash: calculatePlatformRulesHash(frozenRules),
    promptContentHash: promptHashes[0]!,
    promptVersionId: promptIds[0]!,
    qualityRulesHash: calculateQualityRulesHash(rows.map((row) => row.checkerVersion)),
    variants: Object.freeze(variants),
  });
}

async function loadCitations(
  transaction: TransactionSql,
  tenantId: string,
  contentVersionIds: readonly string[],
): Promise<readonly CitationRow[]> {
  return transaction<CitationRow[]>`
    SELECT
      id AS "aiCitationId",
      content_version_id AS "contentVersionId",
      claim_key AS "claimKey",
      claim_text AS "claimText",
      chunk_id AS "chunkId",
      quote_text AS "quoteText",
      quote_hash AS "quoteHash"
    FROM ai_citations AS citation
    WHERE citation.tenant_id = ${tenantId}::uuid
      AND citation.content_version_id = ANY(${contentVersionIds}::uuid[])
    ORDER BY content_version_id, id
  `;
}

function toFrozenCitation(citation: CitationRow): FrozenCitationMaterial {
  return Object.freeze({
    aiCitationId: citation.aiCitationId,
    citationHash: calculateCitationHash(citation),
  });
}

function toSnapshotInput(
  packageId: string,
  snapshotHash: string,
  material: FrozenSnapshotMaterial,
): CreateReviewSnapshotInput {
  return Object.freeze({
    brandProfileId: material.brandProfileId,
    modelKey: material.modelKey,
    packageId,
    platformRulesHash: material.platformRulesHash,
    promptVersionId: material.promptVersionId,
    qualityRulesHash: material.qualityRulesHash,
    snapshotHash,
    variants: material.variants.map((variant) => ({
      citations: variant.citations.map((citation) => ({
        aiCitationId: citation.aiCitationId,
        citationHash: citation.citationHash,
      })),
      contentHash: variant.contentHash,
      contentVersionId: variant.contentVersionId,
      platformRuleVersionId: variant.platformRuleVersionId,
      qualityReportId: variant.qualityReportId,
      variantId: variant.variantId,
    })),
  });
}

async function findExistingSnapshot(
  transaction: TransactionSql,
  scope: ReviewScope,
  packageId: string,
  snapshotHash: string,
  repository: ReviewRepository,
): Promise<ReviewSnapshotView | undefined> {
  const rows = await transaction<{ id: string }[]>`
    SELECT id
    FROM review_snapshots
    WHERE tenant_id = ${scope.tenantId}::uuid
      AND package_id = ${packageId}::uuid
      AND snapshot_hash = ${snapshotHash}
    LIMIT 1
  `;
  const id = rows[0]?.id;
  return id ? repository.findSnapshot(scope, id, transaction) : undefined;
}

async function transitionVariants(
  transaction: TransactionSql,
  tenantId: string,
  rows: readonly SubmissionVariantRow[],
): Promise<void> {
  for (const row of rows) {
    const updated = await transaction<{ id: string }[]>`
      UPDATE content_variants
      SET status = 'in_review', version = version + 1
      WHERE id = ${row.variantId}::uuid
        AND tenant_id = ${tenantId}::uuid
        AND status = 'quality_passed'
        AND version = ${row.version}
        AND current_content_version_id = ${row.contentVersionId}::uuid
      RETURNING id
    `;
    if (updated.length !== 1) versionConflict();
  }
}

async function projectPackageStatus(
  transaction: TransactionSql,
  tenantId: string,
  packageId: string,
  currentStatus: ContentPackageStatus,
  projector: PackageStatusProjector,
): Promise<ContentPackageStatus> {
  const rows = await transaction<ProjectionRow[]>`
    SELECT status, is_required AS "isRequired"
    FROM content_variants
    WHERE tenant_id = ${tenantId}::uuid AND package_id = ${packageId}::uuid
    ORDER BY id
  `;
  const projected = projector.project({ currentStatus, hasActiveReview: true, variants: rows });
  return projected;
}

function inputInvalid(message: string): never {
  throw new SubmitReviewError('REVIEW_INPUT_INVALID', message);
}

function notFound(): never {
  throw new SubmitReviewError(
    'REVIEW_SCOPE_NOT_FOUND',
    'Review package or variants were not found',
  );
}

function stateInvalid(message: string): never {
  throw new SubmitReviewError('REVIEW_STATE_INVALID', message);
}

function versionConflict(): never {
  throw new SubmitReviewError('REVIEW_VERSION_CONFLICT', 'Review submission state changed');
}
