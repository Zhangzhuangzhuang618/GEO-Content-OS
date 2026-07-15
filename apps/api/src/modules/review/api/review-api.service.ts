import type {
  ClaimReviewRequest,
  RequestSignoffRequest,
  ReviewDecisionRequest as ApiReviewDecisionRequest,
  ReviewInboxQuery,
  SubmitReviewRequest as ApiSubmitReviewRequest,
} from '@geo-content-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { TransactionSql } from 'postgres';

import type { JsonValue } from '../../../common/idempotency/index.js';
import { IdentityAuthDatabase } from '../../identity/auth/auth.database.js';
import { ReviewDecisionService, type ReviewDecisionScope } from '../decisions/index.js';
import {
  ReviewRepository,
  type ReviewActionView,
  type ReviewRequirementView,
  type ReviewScope,
  type ReviewSnapshotView,
} from '../repositories/index.js';
import { SubmitReviewService } from '../submit/index.js';
import { ReviewApiError } from './review-api.errors.js';

type SqlClient = IdentityAuthDatabase['client'] | TransactionSql;

interface ResourceScope {
  readonly projectId: string;
  readonly workspaceId: string;
}

interface InboxRow {
  readonly brandProfileId: string;
  readonly claimedAt: Date | null;
  readonly claimedBy: string | null;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly dueAt: Date | null;
  readonly id: string;
  readonly modelKey: string;
  readonly packageId: string;
  readonly pendingSignoffCount: number;
  readonly platformCodes: readonly string[];
  readonly platformRulesHash: string;
  readonly projectId: string;
  readonly promptVersionId: string;
  readonly qualityRulesHash: string;
  readonly riskLevel: 'low' | 'medium' | 'high' | 'critical' | null;
  readonly snapshotHash: string;
  readonly status: string;
  readonly tenantId: string;
  readonly updatedAt: Date;
  readonly variantCount: number;
  readonly version: number;
  readonly workspaceId: string;
}

interface BrandPromptRow {
  readonly brandId: string;
  readonly brandProfile: JsonValue;
  readonly brandSchemaVersion: string;
  readonly brandVersion: number;
  readonly promptContentHash: string;
  readonly promptId: string;
  readonly promptSchemaVersion: string;
  readonly promptSkillName: string;
  readonly promptVersion: string;
}

interface FrozenVariantRow {
  readonly checkerVersion: string;
  readonly contentJson: JsonValue;
  readonly geoScores: JsonValue;
  readonly issues: JsonValue;
  readonly platformCode: string;
  readonly qualityDecision: 'pass';
  readonly qualityReportId: string;
  readonly qualityScore: string;
  readonly ruleContentHash: string;
  readonly ruleId: string;
  readonly rulesJson: JsonValue;
  readonly ruleVersion: string;
  readonly schemaVersion: string;
  readonly snapshotVariantId: string;
}

interface CitationDetailRow {
  readonly aiCitationId: string;
  readonly chunkId: string;
  readonly claimKey: string;
  readonly claimText: string;
  readonly quoteHash: string;
  readonly quoteText: string;
  readonly snapshotVariantId: string;
}

export interface ReviewAuditContext {
  readonly ip?: string;
  readonly requestId: string;
}

@Injectable()
export class ReviewApiService {
  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
  ) {}

  public async submit(
    transaction: TransactionSql,
    tenantId: string,
    userId: string,
    packageId: string,
    request: ApiSubmitReviewRequest,
    audit: ReviewAuditContext,
  ): Promise<JsonValue> {
    const resource = await this.scopeForPackage(transaction, tenantId, userId, packageId);
    const result = await new SubmitReviewService(this.database.client).submit(
      decisionScope(tenantId, userId, resource, audit),
      { packageId, variantIds: request.variant_ids },
      transaction,
    );
    return mapSnapshot(result.snapshot);
  }

  public async list(
    tenantId: string,
    userId: string,
    query: ReviewInboxQuery,
  ): Promise<{ readonly items: readonly JsonValue[]; readonly nextCursor: string | null }> {
    const offset = query.cursor ? decodeCursor(query.cursor) : 0;
    const rows = await this.database.client<InboxRow[]>`
      SELECT
        snapshot.id,
        snapshot.tenant_id AS "tenantId",
        snapshot.package_id AS "packageId",
        snapshot.snapshot_hash AS "snapshotHash",
        snapshot.brand_profile_id AS "brandProfileId",
        snapshot.prompt_version_id AS "promptVersionId",
        snapshot.model_key AS "modelKey",
        snapshot.platform_rules_hash AS "platformRulesHash",
        snapshot.quality_rules_hash AS "qualityRulesHash",
        snapshot.status,
        snapshot.version,
        snapshot.created_by AS "createdBy",
        snapshot.claimed_by AS "claimedBy",
        snapshot.claimed_at AS "claimedAt",
        snapshot.risk_level AS "riskLevel",
        snapshot.due_at AS "dueAt",
        snapshot.created_at AS "createdAt",
        snapshot.updated_at AS "updatedAt",
        package.workspace_id AS "workspaceId",
        package.project_id AS "projectId",
        count(DISTINCT snapshot_variant.id)::integer AS "variantCount",
        array_agg(DISTINCT variant.platform_code ORDER BY variant.platform_code) AS "platformCodes",
        count(DISTINCT requirement.id) FILTER (WHERE requirement.status = 'pending')::integer
          AS "pendingSignoffCount"
      FROM review_snapshots AS snapshot
      JOIN content_packages AS package
        ON package.id = snapshot.package_id AND package.tenant_id = snapshot.tenant_id
      JOIN review_snapshot_variants AS snapshot_variant
        ON snapshot_variant.snapshot_id = snapshot.id
        AND snapshot_variant.tenant_id = snapshot.tenant_id
      JOIN content_variants AS variant
        ON variant.id = snapshot_variant.variant_id
        AND variant.tenant_id = snapshot_variant.tenant_id
      LEFT JOIN review_requirements AS requirement
        ON requirement.snapshot_id = snapshot.id AND requirement.tenant_id = snapshot.tenant_id
      WHERE snapshot.tenant_id = ${tenantId}::uuid
        AND package.deleted_at IS NULL
        AND has_project_scope_access(
          package.tenant_id, package.workspace_id, package.project_id, ${userId}::uuid
        )
        AND (${query.workspace_id ?? null}::uuid IS NULL OR package.workspace_id = ${query.workspace_id ?? null}::uuid)
        AND (${query.project_id ?? null}::uuid IS NULL OR package.project_id = ${query.project_id ?? null}::uuid)
        AND (${query.created_by ?? null}::uuid IS NULL OR snapshot.created_by = ${query.created_by ?? null}::uuid)
        AND (${query.risk_level ?? null}::varchar IS NULL OR snapshot.risk_level = ${query.risk_level ?? null})
        AND (
          ${query.claim_state ?? null}::varchar IS NULL
          OR (${query.claim_state ?? null} = 'unclaimed' AND snapshot.claimed_by IS NULL)
          OR (${query.claim_state ?? null} = 'mine' AND snapshot.claimed_by = ${userId}::uuid)
        )
        AND (${query.status ?? null}::varchar IS NULL OR snapshot.status = ${query.status ?? null})
        AND (${query.platform_code ?? null}::varchar IS NULL OR EXISTS (
          SELECT 1 FROM review_snapshot_variants AS selected
          JOIN content_variants AS selected_variant
            ON selected_variant.id = selected.variant_id
            AND selected_variant.tenant_id = selected.tenant_id
          WHERE selected.snapshot_id = snapshot.id
            AND selected.tenant_id = snapshot.tenant_id
            AND selected_variant.platform_code = ${query.platform_code ?? null}
        ))
      GROUP BY snapshot.id, package.workspace_id, package.project_id
      ORDER BY snapshot.created_at DESC, snapshot.id DESC
      LIMIT ${query.limit + 1} OFFSET ${offset}
    `;
    const hasNext = rows.length > query.limit;
    return {
      items: Object.freeze(rows.slice(0, query.limit).map(mapInboxItem)),
      nextCursor: hasNext ? encodeCursor(offset + query.limit) : null,
    };
  }

  public async claim(
    transaction: TransactionSql,
    tenantId: string,
    userId: string,
    snapshotId: string,
    request: ClaimReviewRequest,
    expectedVersion: number,
    audit: ReviewAuditContext,
  ): Promise<JsonValue> {
    await this.scopeForSnapshot(transaction, tenantId, userId, snapshotId);
    const dueAt = new Date(request.due_at);
    if (dueAt.getTime() <= Date.now()) validation('Review due_at must be in the future');
    const beforeRows = await transaction<
      { claimedBy: string | null; status: string; version: number }[]
    >`
      SELECT claimed_by AS "claimedBy", status, version
      FROM review_snapshots
      WHERE id = ${snapshotId}::uuid AND tenant_id = ${tenantId}::uuid
      FOR UPDATE
    `;
    const before = beforeRows[0];
    if (!before) notFound();
    if (before.version !== expectedVersion) {
      throw new ReviewApiError('version', 'Review snapshot version does not match');
    }
    if (before.status !== 'in_review') {
      throw new ReviewApiError('state', 'Only in-review snapshots may be claimed');
    }
    if (before.claimedBy && before.claimedBy !== userId) {
      throw new ReviewApiError('state', 'Review snapshot is already claimed by another reviewer');
    }
    const rows = await transaction<
      {
        claimedAt: Date;
        claimedBy: string;
        dueAt: Date;
        riskLevel: ClaimReviewRequest['risk_level'];
        version: number;
      }[]
    >`
      UPDATE review_snapshots
      SET claimed_by = ${userId}::uuid,
          claimed_at = COALESCE(claimed_at, now()),
          risk_level = ${request.risk_level},
          due_at = ${request.due_at}::timestamptz,
          version = version + 1
      WHERE id = ${snapshotId}::uuid AND tenant_id = ${tenantId}::uuid
        AND version = ${expectedVersion}
      RETURNING claimed_by AS "claimedBy", claimed_at AS "claimedAt",
        risk_level AS "riskLevel", due_at AS "dueAt", version
    `;
    const claimed = rows[0];
    if (!claimed) throw new ReviewApiError('version', 'Review snapshot version does not match');
    await transaction`
      INSERT INTO audit_events (
        tenant_id, actor_id, action, resource_type, resource_id,
        before_json, after_json, ip, request_id
      ) VALUES (
        ${tenantId}::uuid, ${userId}::uuid, 'review_snapshot.claimed',
        'review_snapshot', ${snapshotId}::uuid,
        ${JSON.stringify(before)}::text::jsonb,
        ${JSON.stringify({
          claimed_by: claimed.claimedBy,
          due_at: claimed.dueAt.toISOString(),
          risk_level: claimed.riskLevel,
          version: claimed.version,
        })}::text::jsonb,
        ${audit.ip ?? null}, ${audit.requestId}
      )
    `;
    return {
      claimed_at: iso(claimed.claimedAt),
      claimed_by: claimed.claimedBy,
      due_at: iso(claimed.dueAt),
      risk_level: claimed.riskLevel,
      snapshot_id: snapshotId,
      version: claimed.version,
    };
  }

  public async detail(
    tenantId: string,
    userId: string,
    snapshotId: string,
    transaction?: TransactionSql,
  ): Promise<JsonValue> {
    const client = transaction ?? this.database.client;
    const resource = await this.scopeForSnapshot(client, tenantId, userId, snapshotId);
    const scope: ReviewScope = { ...resource, tenantId, userId };
    const repository = new ReviewRepository(this.database.client);
    const snapshot = await repository.findSnapshot(scope, snapshotId, client);
    if (!snapshot) notFound();
    const heads = await client<BrandPromptRow[]>`
      SELECT
        brand.id AS "brandId", brand.version AS "brandVersion",
        brand.schema_version AS "brandSchemaVersion", brand.profile_json AS "brandProfile",
        prompt.id AS "promptId", prompt.skill_name AS "promptSkillName",
        prompt.version AS "promptVersion", prompt.schema_version AS "promptSchemaVersion",
        prompt.content_hash AS "promptContentHash"
      FROM review_snapshots AS review
      JOIN brand_profiles AS brand
        ON brand.id = review.brand_profile_id AND brand.tenant_id = review.tenant_id
      JOIN prompt_versions AS prompt ON prompt.id = review.prompt_version_id
      WHERE review.id = ${snapshotId}::uuid AND review.tenant_id = ${tenantId}::uuid
    `;
    const head = heads[0];
    if (!head) notFound();
    const variants = await client<FrozenVariantRow[]>`
      SELECT
        snapshot_variant.id AS "snapshotVariantId",
        variant.platform_code AS "platformCode",
        content.schema_version AS "schemaVersion", content.content_json AS "contentJson",
        rule.id AS "ruleId", rule.version AS "ruleVersion",
        rule.rules_json AS "rulesJson", rule.content_hash AS "ruleContentHash",
        report.id AS "qualityReportId", report.checker_version AS "checkerVersion",
        report.score::text AS "qualityScore", report.decision AS "qualityDecision",
        report.issues_json AS issues, report.geo_scores_json AS "geoScores"
      FROM review_snapshot_variants AS snapshot_variant
      JOIN content_variants AS variant
        ON variant.id = snapshot_variant.variant_id AND variant.tenant_id = snapshot_variant.tenant_id
      JOIN content_versions AS content
        ON content.id = snapshot_variant.content_version_id AND content.tenant_id = snapshot_variant.tenant_id
      JOIN platform_rule_versions AS rule ON rule.id = snapshot_variant.platform_rule_version_id
      JOIN quality_reports AS report
        ON report.id = snapshot_variant.quality_report_id AND report.tenant_id = snapshot_variant.tenant_id
      WHERE snapshot_variant.snapshot_id = ${snapshotId}::uuid
        AND snapshot_variant.tenant_id = ${tenantId}::uuid
      ORDER BY snapshot_variant.id
    `;
    const citations = await client<CitationDetailRow[]>`
      SELECT frozen.snapshot_variant_id AS "snapshotVariantId",
        citation.id AS "aiCitationId", citation.claim_key AS "claimKey",
        citation.claim_text AS "claimText", citation.chunk_id AS "chunkId",
        citation.quote_text AS "quoteText", citation.quote_hash AS "quoteHash"
      FROM review_snapshot_citations AS frozen
      JOIN review_snapshot_variants AS snapshot_variant
        ON snapshot_variant.id = frozen.snapshot_variant_id AND snapshot_variant.tenant_id = frozen.tenant_id
      JOIN ai_citations AS citation
        ON citation.id = frozen.ai_citation_id AND citation.tenant_id = frozen.tenant_id
      WHERE snapshot_variant.snapshot_id = ${snapshotId}::uuid AND frozen.tenant_id = ${tenantId}::uuid
      ORDER BY frozen.snapshot_variant_id, frozen.id
    `;
    return {
      actions: snapshot.actions.map(mapAction),
      brand_profile: {
        id: head.brandId,
        profile_json: head.brandProfile,
        schema_version: head.brandSchemaVersion,
        version: head.brandVersion,
      },
      prompt_version: {
        content_hash: head.promptContentHash,
        id: head.promptId,
        schema_version: head.promptSchemaVersion,
        skill_name: head.promptSkillName,
        version: head.promptVersion,
      },
      snapshot: mapSnapshot(snapshot),
      variants: variants.map((variant) => ({
        citations: citations
          .filter((citation) => citation.snapshotVariantId === variant.snapshotVariantId)
          .map((citation) => ({
            ai_citation_id: citation.aiCitationId,
            chunk_id: citation.chunkId,
            claim_key: citation.claimKey,
            claim_text: citation.claimText,
            quote_hash: citation.quoteHash,
            quote_text: citation.quoteText,
          })),
        content_json: variant.contentJson,
        platform_code: variant.platformCode,
        platform_rule: {
          content_hash: variant.ruleContentHash,
          id: variant.ruleId,
          rules_json: variant.rulesJson,
          version: variant.ruleVersion,
        },
        quality_report: {
          checker_version: variant.checkerVersion,
          decision: variant.qualityDecision,
          geo_scores_json: variant.geoScores,
          id: variant.qualityReportId,
          issues_json: variant.issues,
          score: Number(variant.qualityScore),
        },
        schema_version: variant.schemaVersion,
        snapshot_variant_id: variant.snapshotVariantId,
      })),
    };
  }

  public async decide(
    transaction: TransactionSql,
    tenantId: string,
    userId: string,
    snapshotId: string,
    request: ApiReviewDecisionRequest,
    version: number,
    decision: 'approve' | 'reject',
    audit: ReviewAuditContext,
  ): Promise<JsonValue> {
    const resource = await this.scopeForSnapshot(transaction, tenantId, userId, snapshotId);
    const service = new ReviewDecisionService(this.database.client);
    const input = {
      comment: request.comment,
      expectedVersion: version,
      variantIds: request.variant_ids,
    };
    const scope = decisionScope(tenantId, userId, resource, audit);
    if (decision === 'approve') await service.approve(scope, snapshotId, input, transaction);
    else await service.reject(scope, snapshotId, input, transaction);
    return this.detail(tenantId, userId, snapshotId, transaction);
  }

  public async requestSignoff(
    transaction: TransactionSql,
    tenantId: string,
    userId: string,
    snapshotId: string,
    request: RequestSignoffRequest,
    version: number,
    audit: ReviewAuditContext,
  ): Promise<JsonValue> {
    const resource = await this.scopeForSnapshot(transaction, tenantId, userId, snapshotId);
    const result = await new ReviewDecisionService(this.database.client).requestSignoff(
      decisionScope(tenantId, userId, resource, audit),
      snapshotId,
      {
        comment: request.comment,
        expectedVersion: version,
        ...(request.required_role ? { requiredRole: request.required_role } : {}),
        ...(request.required_user_id ? { requiredUserId: request.required_user_id } : {}),
        variantIds: [request.variant_id],
      },
      transaction,
    );
    const requirement = [...result.snapshot.requirements]
      .reverse()
      .find(
        (item) =>
          item.requestedBy === userId &&
          item.variantId === request.variant_id &&
          item.requiredRole === (request.required_role ?? null) &&
          item.requiredUserId === (request.required_user_id ?? null),
      );
    if (!requirement) throw new Error('Created review requirement is missing from the response');
    return mapRequirement(requirement);
  }

  public async actions(tenantId: string, userId: string, snapshotId: string): Promise<JsonValue[]> {
    const resource = await this.scopeForSnapshot(
      this.database.client,
      tenantId,
      userId,
      snapshotId,
    );
    const snapshot = await new ReviewRepository(this.database.client).findSnapshot(
      { ...resource, tenantId, userId },
      snapshotId,
    );
    if (!snapshot) notFound();
    return snapshot.actions.map(mapAction);
  }

  private async scopeForPackage(
    client: SqlClient,
    tenantId: string,
    userId: string,
    packageId: string,
  ): Promise<ResourceScope> {
    const rows = await client<ResourceScope[]>`
      SELECT workspace_id AS "workspaceId", project_id AS "projectId"
      FROM content_packages
      WHERE id = ${packageId}::uuid AND tenant_id = ${tenantId}::uuid
        AND deleted_at IS NULL
        AND has_project_scope_access(tenant_id, workspace_id, project_id, ${userId}::uuid)
      LIMIT 1
    `;
    if (!rows[0]) notFound();
    return rows[0];
  }

  private async scopeForSnapshot(
    client: SqlClient,
    tenantId: string,
    userId: string,
    snapshotId: string,
  ): Promise<ResourceScope> {
    const rows = await client<ResourceScope[]>`
      SELECT package.workspace_id AS "workspaceId", package.project_id AS "projectId"
      FROM review_snapshots AS snapshot
      JOIN content_packages AS package
        ON package.id = snapshot.package_id AND package.tenant_id = snapshot.tenant_id
      WHERE snapshot.id = ${snapshotId}::uuid AND snapshot.tenant_id = ${tenantId}::uuid
        AND package.deleted_at IS NULL
        AND has_project_scope_access(
          package.tenant_id, package.workspace_id, package.project_id, ${userId}::uuid
        )
      LIMIT 1
    `;
    if (!rows[0]) notFound();
    return rows[0];
  }
}

function decisionScope(
  tenantId: string,
  userId: string,
  resource: ResourceScope,
  audit: ReviewAuditContext,
): ReviewDecisionScope {
  return {
    ...resource,
    ...(audit.ip ? { ip: audit.ip } : {}),
    requestId: audit.requestId,
    tenantId,
    userId,
  };
}

function mapSnapshot(snapshot: ReviewSnapshotView): JsonValue {
  return {
    brand_profile_id: snapshot.brandProfileId,
    created_at: iso(snapshot.createdAt),
    created_by: snapshot.createdBy,
    id: snapshot.id,
    model_key: snapshot.modelKey,
    package_id: snapshot.packageId,
    platform_rules_hash: snapshot.platformRulesHash,
    prompt_version_id: snapshot.promptVersionId,
    quality_rules_hash: snapshot.qualityRulesHash,
    requirements: snapshot.requirements.map(mapRequirement),
    snapshot_hash: snapshot.snapshotHash,
    status: snapshot.status,
    tenant_id: snapshot.tenantId,
    updated_at: iso(snapshot.updatedAt),
    variants: snapshot.variants.map((variant) => ({
      citations: variant.citations.map((citation) => ({
        ai_citation_id: citation.aiCitationId,
        citation_hash: citation.citationHash,
        created_at: iso(citation.createdAt),
        id: citation.id,
        snapshot_variant_id: citation.snapshotVariantId,
        tenant_id: citation.tenantId,
      })),
      content_hash: variant.contentHash,
      content_version_id: variant.contentVersionId,
      created_at: iso(variant.createdAt),
      id: variant.id,
      platform_code: variant.platformCode,
      platform_rule_version_id: variant.platformRuleVersionId,
      quality_report_id: variant.qualityReportId,
      snapshot_id: variant.snapshotId,
      status: variant.status,
      tenant_id: variant.tenantId,
      variant_id: variant.variantId,
    })),
    version: snapshot.version,
  };
}

function mapRequirement(requirement: ReviewRequirementView): JsonValue {
  return {
    completed_at: requirement.completedAt ? iso(requirement.completedAt) : null,
    created_at: iso(requirement.createdAt),
    id: requirement.id,
    requested_by: requirement.requestedBy,
    required_role: requirement.requiredRole,
    required_user_id: requirement.requiredUserId,
    snapshot_id: requirement.snapshotId,
    status: requirement.status,
    tenant_id: requirement.tenantId,
    updated_at: iso(requirement.updatedAt),
    variant_id: requirement.variantId,
  };
}

function mapAction(action: ReviewActionView): JsonValue {
  return {
    action: action.action,
    comment: action.comment,
    created_at: iso(action.createdAt),
    id: action.id,
    reviewer_id: action.reviewerId,
    snapshot_id: action.snapshotId,
    tenant_id: action.tenantId,
    variant_ids: [...action.variantIds],
  };
}

function mapInboxItem(row: InboxRow): JsonValue {
  return {
    brand_profile_id: row.brandProfileId,
    claimed_at: row.claimedAt ? iso(row.claimedAt) : null,
    claimed_by: row.claimedBy,
    created_at: iso(row.createdAt),
    created_by: row.createdBy,
    due_at: row.dueAt ? iso(row.dueAt) : null,
    id: row.id,
    model_key: row.modelKey,
    package_id: row.packageId,
    pending_signoff_count: row.pendingSignoffCount,
    platform_codes: [...row.platformCodes],
    platform_rules_hash: row.platformRulesHash,
    project_id: row.projectId,
    prompt_version_id: row.promptVersionId,
    quality_rules_hash: row.qualityRulesHash,
    risk_level: row.riskLevel,
    snapshot_hash: row.snapshotHash,
    status: row.status,
    tenant_id: row.tenantId,
    updated_at: iso(row.updatedAt),
    variant_count: row.variantCount,
    version: row.version,
    workspace_id: row.workspaceId,
  };
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^(?:0|[1-9][0-9]*)$/u.test(decoded)) validation('cursor is invalid');
  const offset = Number(decoded);
  if (!Number.isSafeInteger(offset) || offset < 0) validation('cursor is invalid');
  return offset;
}

function iso(value: Date): string {
  return value.toISOString();
}

function notFound(): never {
  throw new ReviewApiError('not_found', 'Review resource was not found');
}

function validation(message: string): never {
  throw new ReviewApiError('validation', message);
}
