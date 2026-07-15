import { randomUUID } from 'node:crypto';
import type { PlatformCode } from '@geo-content-os/contracts';
import type { TransactionSql } from 'postgres';

import type { DatabaseClient } from '../../../database/index.js';

type SqlClient = DatabaseClient | TransactionSql;

export interface ReviewScope {
  readonly projectId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

export type ReviewSnapshotStatus = 'in_review' | 'approved' | 'rejected' | 'superseded';
export type ReviewVariantStatus = 'in_review' | 'approved' | 'rejected';
export type ReviewRequirementStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type ReviewActionKind = 'approve' | 'reject' | 'request_signoff' | 'comment';

export interface ReviewCitationInput {
  readonly aiCitationId: string;
  readonly citationHash: string;
  readonly id?: string;
}

export interface ReviewVariantInput {
  readonly citations: readonly ReviewCitationInput[];
  readonly contentHash: string;
  readonly contentVersionId: string;
  readonly id?: string;
  readonly platformRuleVersionId: string;
  readonly qualityReportId: string;
  readonly variantId: string;
}

export interface ReviewRequirementInput {
  readonly id?: string;
  readonly requiredRole?: string;
  readonly requiredUserId?: string;
  readonly variantId?: string;
}

export interface CreateReviewSnapshotInput {
  readonly brandProfileId: string;
  readonly id?: string;
  readonly modelKey: string;
  readonly packageId: string;
  readonly platformRulesHash: string;
  readonly promptVersionId: string;
  readonly qualityRulesHash: string;
  readonly requirements?: readonly ReviewRequirementInput[];
  readonly snapshotHash: string;
  readonly variants: readonly ReviewVariantInput[];
}

export interface ReviewSnapshotView {
  readonly actions: readonly ReviewActionView[];
  readonly brandProfileId: string;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly id: string;
  readonly modelKey: string;
  readonly packageId: string;
  readonly platformRulesHash: string;
  readonly promptVersionId: string;
  readonly qualityRulesHash: string;
  readonly requirements: readonly ReviewRequirementView[];
  readonly snapshotHash: string;
  readonly status: ReviewSnapshotStatus;
  readonly tenantId: string;
  readonly updatedAt: Date;
  readonly variants: readonly ReviewSnapshotVariantView[];
  readonly version: number;
}

export interface ReviewSnapshotVariantView {
  readonly citations: readonly ReviewSnapshotCitationView[];
  readonly contentHash: string;
  readonly contentVersionId: string;
  readonly createdAt: Date;
  readonly id: string;
  readonly platformCode: PlatformCode;
  readonly platformRuleVersionId: string;
  readonly qualityReportId: string;
  readonly snapshotId: string;
  readonly status: ReviewVariantStatus;
  readonly tenantId: string;
  readonly variantId: string;
}

export interface ReviewSnapshotCitationView {
  readonly aiCitationId: string;
  readonly citationHash: string;
  readonly createdAt: Date;
  readonly id: string;
  readonly snapshotVariantId: string;
  readonly tenantId: string;
}

export interface ReviewRequirementView {
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly id: string;
  readonly requestedBy: string;
  readonly requiredRole: string | null;
  readonly requiredUserId: string | null;
  readonly snapshotId: string;
  readonly status: ReviewRequirementStatus;
  readonly tenantId: string;
  readonly updatedAt: Date;
  readonly variantId: string | null;
}

export interface ReviewActionView {
  readonly action: ReviewActionKind;
  readonly comment: string | null;
  readonly createdAt: Date;
  readonly id: string;
  readonly reviewerId: string;
  readonly snapshotId: string;
  readonly tenantId: string;
  readonly variantIds: readonly string[];
}

type SnapshotRow = Omit<ReviewSnapshotView, 'actions' | 'requirements' | 'variants'>;

type VariantRow = Omit<ReviewSnapshotVariantView, 'citations'>;

/** Tenant/project-scoped persistence for immutable review graphs. */
export class ReviewRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async withTransaction<T>(work: (transaction: TransactionSql) => Promise<T>): Promise<T> {
    return (await this.client.begin(work)) as T;
  }

  public async createSnapshot(
    scope: ReviewScope,
    input: CreateReviewSnapshotInput,
  ): Promise<ReviewSnapshotView> {
    return this.withTransaction(async (transaction) => {
      const snapshotId = await this.insertSnapshot(transaction, scope, input);
      const snapshot = await this.findSnapshot(scope, snapshotId, transaction);
      if (!snapshot) throw new Error('Review snapshot insert returned no scoped row');
      return snapshot;
    });
  }

  public async insertSnapshot(
    client: SqlClient,
    scope: ReviewScope,
    input: CreateReviewSnapshotInput,
  ): Promise<string> {
    const accessiblePackages = await client<{ id: string }[]>`
      SELECT package.id
      FROM content_packages AS package
      WHERE package.id = ${input.packageId}::uuid
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
    `;
    if (accessiblePackages.length !== 1) {
      throw new Error('Review package is outside the caller project scope');
    }
    const snapshotId = input.id ?? randomUUID();
    await client`
      INSERT INTO review_snapshots (
        id, tenant_id, package_id, snapshot_hash, brand_profile_id,
        prompt_version_id, model_key, platform_rules_hash, quality_rules_hash, created_by
      ) VALUES (
        ${snapshotId}::uuid, ${scope.tenantId}::uuid, ${input.packageId}::uuid,
        ${input.snapshotHash}, ${input.brandProfileId}::uuid, ${input.promptVersionId}::uuid,
        ${input.modelKey}, ${input.platformRulesHash}, ${input.qualityRulesHash},
        ${scope.userId}::uuid
      )
    `;

    for (const variant of input.variants) {
      const snapshotVariantId = variant.id ?? randomUUID();
      await client`
        INSERT INTO review_snapshot_variants (
          id, tenant_id, snapshot_id, variant_id, content_version_id,
          content_hash, platform_rule_version_id, quality_report_id
        ) VALUES (
          ${snapshotVariantId}::uuid, ${scope.tenantId}::uuid, ${snapshotId}::uuid,
          ${variant.variantId}::uuid, ${variant.contentVersionId}::uuid,
          ${variant.contentHash}, ${variant.platformRuleVersionId}::uuid,
          ${variant.qualityReportId}::uuid
        )
      `;
      for (const citation of variant.citations) {
        await client`
          INSERT INTO review_snapshot_citations (
            id, tenant_id, snapshot_variant_id, ai_citation_id, citation_hash
          ) VALUES (
            ${citation.id ?? randomUUID()}::uuid, ${scope.tenantId}::uuid,
            ${snapshotVariantId}::uuid, ${citation.aiCitationId}::uuid,
            ${citation.citationHash}
          )
        `;
      }
    }

    for (const requirement of input.requirements ?? []) {
      await client`
        INSERT INTO review_requirements (
          id, tenant_id, snapshot_id, variant_id, required_role,
          required_user_id, requested_by
        ) VALUES (
          ${requirement.id ?? randomUUID()}::uuid, ${scope.tenantId}::uuid,
          ${snapshotId}::uuid, ${requirement.variantId ?? null}::uuid,
          ${requirement.requiredRole ?? null}, ${requirement.requiredUserId ?? null}::uuid,
          ${scope.userId}::uuid
        )
      `;
    }
    return snapshotId;
  }

  public async findSnapshot(
    scope: ReviewScope,
    snapshotId: string,
    client: SqlClient = this.client,
  ): Promise<ReviewSnapshotView | undefined> {
    const snapshots = await client<SnapshotRow[]>`
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
        snapshot.created_at AS "createdAt",
        snapshot.updated_at AS "updatedAt"
      FROM review_snapshots AS snapshot
      JOIN content_packages AS package
        ON package.id = snapshot.package_id AND package.tenant_id = snapshot.tenant_id
      WHERE snapshot.id = ${snapshotId}::uuid
        AND snapshot.tenant_id = ${scope.tenantId}::uuid
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
    `;
    const snapshot = snapshots[0];
    if (!snapshot) return undefined;

    const variants = await client<VariantRow[]>`
      SELECT
        snapshot_variant.id,
        snapshot_variant.tenant_id AS "tenantId",
        snapshot_variant.snapshot_id AS "snapshotId",
        snapshot_variant.variant_id AS "variantId",
        snapshot_variant.content_version_id AS "contentVersionId",
        snapshot_variant.content_hash AS "contentHash",
        snapshot_variant.platform_rule_version_id AS "platformRuleVersionId",
        snapshot_variant.quality_report_id AS "qualityReportId",
        variant.platform_code AS "platformCode",
        snapshot_variant.status,
        snapshot_variant.created_at AS "createdAt"
      FROM review_snapshot_variants AS snapshot_variant
      JOIN content_variants AS variant
        ON variant.id = snapshot_variant.variant_id
        AND variant.tenant_id = snapshot_variant.tenant_id
      WHERE snapshot_variant.tenant_id = ${scope.tenantId}::uuid
        AND snapshot_variant.snapshot_id = ${snapshotId}::uuid
      ORDER BY snapshot_variant.created_at, snapshot_variant.id
    `;
    const citations = await client<ReviewSnapshotCitationView[]>`
      SELECT
        citation.id,
        citation.tenant_id AS "tenantId",
        citation.snapshot_variant_id AS "snapshotVariantId",
        citation.ai_citation_id AS "aiCitationId",
        citation.citation_hash AS "citationHash",
        citation.created_at AS "createdAt"
      FROM review_snapshot_citations AS citation
      JOIN review_snapshot_variants AS snapshot_variant
        ON snapshot_variant.id = citation.snapshot_variant_id
        AND snapshot_variant.tenant_id = citation.tenant_id
      WHERE citation.tenant_id = ${scope.tenantId}::uuid
        AND snapshot_variant.snapshot_id = ${snapshotId}::uuid
      ORDER BY citation.created_at, citation.id
    `;
    const requirements = await client<ReviewRequirementView[]>`
      SELECT
        requirement.id,
        requirement.tenant_id AS "tenantId",
        requirement.snapshot_id AS "snapshotId",
        requirement.variant_id AS "variantId",
        requirement.required_role AS "requiredRole",
        requirement.required_user_id AS "requiredUserId",
        requirement.status,
        requirement.requested_by AS "requestedBy",
        requirement.completed_at AS "completedAt",
        requirement.created_at AS "createdAt",
        requirement.updated_at AS "updatedAt"
      FROM review_requirements AS requirement
      WHERE requirement.tenant_id = ${scope.tenantId}::uuid
        AND requirement.snapshot_id = ${snapshotId}::uuid
      ORDER BY requirement.created_at, requirement.id
    `;
    const actions = await client<ReviewActionView[]>`
      SELECT
        action.id,
        action.tenant_id AS "tenantId",
        action.snapshot_id AS "snapshotId",
        action.reviewer_id AS "reviewerId",
        action.action,
        action.variant_ids AS "variantIds",
        action.comment,
        action.created_at AS "createdAt"
      FROM review_actions AS action
      WHERE action.tenant_id = ${scope.tenantId}::uuid
        AND action.snapshot_id = ${snapshotId}::uuid
      ORDER BY action.created_at, action.id
    `;
    return Object.freeze({
      ...snapshot,
      actions: Object.freeze(actions),
      requirements: Object.freeze(requirements),
      variants: Object.freeze(
        variants.map((variant) =>
          Object.freeze({
            ...variant,
            citations: Object.freeze(
              citations.filter((citation) => citation.snapshotVariantId === variant.id),
            ),
          }),
        ),
      ),
    });
  }
}
