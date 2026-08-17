import {
  ContentDocumentSchema,
  type ContentDocument as ApiContentDocument,
  type ContentPackageQuery,
  type ContentVariantStatus,
  type CreateContentPackageRequest,
  type DomainEventEnvelope,
  type GenerateContentRequest,
  type PlatformCode,
  type RegenerateVariantRequest,
  type ReopenVariantsRequest,
  qualityEvaluationFingerprintSource,
} from '@geo-content-os/contracts';
import {
  createEmbeddingAdapter,
  readEmbeddingConfiguration,
} from '@geo-content-os/adapter-embedding';
import { createRerankAdapter, readRerankConfiguration } from '@geo-content-os/adapter-rerank';
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { TransactionSql } from 'postgres';

import type { JsonValue } from '../../../common/idempotency/index.js';
import type { ContentDocument as DatabaseContentDocument } from '../../../database/schema/index.js';
import { GenerationRequestService } from '../../ai/orchestrator/index.js';
import { IdentityAuthDatabase } from '../../identity/auth/auth.database.js';
import { CitationSearchService, HybridSearchRepository } from '../../knowledge/search/index.js';
import { OutboxWriter } from '../../outbox/index.js';
import { ContentBlockLockRepository } from '../block-locks/index.js';
import { ContentPackageRepository } from '../packages/index.js';
import {
  ContentRepository,
  type ContentGenerationRunView,
  type ContentPackageView,
  type ContentScope,
  type ContentVariantView,
} from '../repositories/index.js';
import { PackageStatusProjector } from '../status/index.js';
import { ContentVariantRepository } from '../variants/index.js';
import { ContentVersionRepository } from '../versions/index.js';
import {
  contentNotFound,
  contentStateInvalid,
  contentValidationInvalid,
  contentVersionConflict,
} from './content-api.errors.js';
import { canRegenerateContentVariant } from './content-api.guards.js';

type SqlClient = IdentityAuthDatabase['client'] | TransactionSql;

const RECOVERABLE_BAIJIAHAO_MANUAL_CODES: readonly string[] = [
  'ADAPTATION_EXECUTION_FAILED',
  'CONTENT_GENERATION_FAILED_RETIRED',
  'QUALITY_CHECK_EXECUTION_FAILED',
  'QUALITY_GATE_FAILED_AFTER_MAX_REWRITES',
];

const RECOVERABLE_BAIJIAHAO_CONTENT_STATES: readonly string[] = [
  'adaptation_pending',
  'adapting',
  'generation_pending',
  'generating',
  'quality_pending',
  'rewrite_pending',
  'rewriting',
];

export interface ContentApiAudit {
  readonly ip?: string;
  readonly requestId: string;
}

interface ScopeSeed {
  readonly projectId: string;
  readonly workspaceId: string;
}

interface PackageCursor {
  readonly id: string;
  readonly updatedAt: string;
}

interface ContentPackageListRow extends ContentPackageView {
  readonly briefTitle: string;
}

interface QualityReportRow {
  readonly automationGateJson: Record<string, unknown> | null;
  readonly checkerVersion: string;
  readonly contentVersionId: string;
  readonly createdAt: Date | string;
  readonly decision: 'block' | 'pass' | 'revise';
  readonly generationRunId: string;
  readonly geoScoresJson: Record<string, unknown>;
  readonly id: string;
  readonly issuesJson: { readonly issues?: readonly unknown[] };
  readonly score: string;
  readonly tenantId: string;
  readonly variantId: string;
}

interface QualityRewriteSource {
  readonly content: ApiContentDocument;
  readonly report: QualityReportRow;
}

interface QualityRewriteRow extends QualityReportRow {
  readonly content: unknown;
  readonly contentHash: string;
  readonly inputHash: string;
}

interface GenerationRuntime {
  readonly modelKey: string;
  readonly promptVersionId: string;
  readonly skillVersion: string;
}

@Injectable()
export class ContentApiService {
  private readonly generation: GenerationRequestService;

  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
    @Inject(OutboxWriter) outbox: OutboxWriter,
  ) {
    this.generation = new GenerationRequestService(outbox);
    this.outbox = outbox;
  }

  private readonly outbox: OutboxWriter;

  private get blocks(): ContentBlockLockRepository {
    return new ContentBlockLockRepository(this.database.client);
  }

  private get packages(): ContentPackageRepository {
    return new ContentPackageRepository(this.database.client);
  }

  private get variants(): ContentVariantRepository {
    return new ContentVariantRepository(this.database.client);
  }

  private get versions(): ContentVersionRepository {
    return new ContentVersionRepository(this.database.client);
  }

  public async createPackage(
    transaction: TransactionSql,
    tenantId: string,
    userId: string,
    input: CreateContentPackageRequest,
    audit: ContentApiAudit,
  ): Promise<JsonValue> {
    const scope = scopeFromInput(tenantId, userId, input);
    const aggregate = await this.packages.createFromBrief(
      transaction,
      scope,
      input.brief_id,
      audit,
    );
    return packageView(aggregate.package);
  }

  public async listPackages(
    tenantId: string,
    userId: string,
    query: ContentPackageQuery,
  ): Promise<{ readonly items: readonly JsonValue[]; readonly nextCursor: string | null }> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.database.client<ContentPackageListRow[]>`
      SELECT
        package.id,
        package.tenant_id AS "tenantId",
        package.workspace_id AS "workspaceId",
        package.project_id AS "projectId",
        package.brief_id AS "briefId",
        package.status,
        package.version,
        package.master_content_version_id AS "masterContentVersionId",
        package.created_by AS "createdBy",
        package.created_at AS "createdAt",
        package.updated_at AS "updatedAt",
        package.deleted_at AS "deletedAt",
        coalesce(brief.title, '历史内容') AS "briefTitle"
      FROM content_packages AS package
      LEFT JOIN briefs AS brief
        ON brief.id = package.brief_id
        AND brief.tenant_id = package.tenant_id
      WHERE package.tenant_id = ${tenantId}::uuid
        AND package.deleted_at IS NULL
        AND has_project_scope_access(
          package.tenant_id, package.workspace_id, package.project_id, ${userId}::uuid
        )
        AND (${query.workspace_id ?? null}::uuid IS NULL OR package.workspace_id = ${query.workspace_id ?? null}::uuid)
        AND (${query.project_id ?? null}::uuid IS NULL OR package.project_id = ${query.project_id ?? null}::uuid)
        AND (${query.created_by ?? null}::uuid IS NULL OR package.created_by = ${query.created_by ?? null}::uuid)
        AND (${query.status ?? null}::text IS NULL OR package.status = ${query.status ?? null})
        AND (
          ${query.attention_required === 'true'}::boolean = false
          OR package.status IN ('all_failed', 'rejected', 'publish_failed')
          OR EXISTS (
            SELECT 1
            FROM content_variants AS attention_variant
            WHERE attention_variant.tenant_id = package.tenant_id
              AND attention_variant.package_id = package.id
              AND attention_variant.is_required = true
              AND attention_variant.status IN (
                'generation_failed', 'quality_failed', 'review_rejected', 'publish_failed'
              )
          )
        )
        AND (
          ${query.platform_code ?? null}::text IS NULL
          OR EXISTS (
            SELECT 1 FROM content_variants AS variant
            WHERE variant.tenant_id = package.tenant_id
              AND variant.package_id = package.id
              AND variant.platform_code = ${query.platform_code ?? null}
          )
        )
        AND (
          ${cursor?.updatedAt ?? null}::timestamptz IS NULL
          OR (package.updated_at, package.id) < (${cursor?.updatedAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid)
        )
      ORDER BY package.updated_at DESC, package.id DESC
      LIMIT ${query.limit + 1}
    `;
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    const tail = page.at(-1);
    const variants =
      page.length === 0
        ? []
        : await this.database.client<ContentVariantView[]>`
            SELECT
              variant.id,
              variant.tenant_id AS "tenantId",
              variant.package_id AS "packageId",
              variant.platform_code AS "platformCode",
              variant.status,
              variant.is_required AS "isRequired",
              variant.current_content_version_id AS "currentContentVersionId",
              variant.quality_score::text AS "qualityScore",
              variant.version,
              variant.created_at AS "createdAt",
              variant.updated_at AS "updatedAt"
            FROM content_variants AS variant
            WHERE variant.tenant_id = ${tenantId}::uuid
              AND variant.package_id = ANY(${page.map((item) => item.id)}::uuid[])
            ORDER BY variant.package_id, variant.platform_code
          `;
    const variantsByPackage = new Map<string, ContentVariantView[]>();
    for (const variant of variants) {
      const packageVariants = variantsByPackage.get(variant.packageId) ?? [];
      packageVariants.push(variant);
      variantsByPackage.set(variant.packageId, packageVariants);
    }
    return {
      items: page.map((item) => packageListItemView(item, variantsByPackage.get(item.id) ?? [])),
      nextCursor:
        hasMore && tail ? encodeCursor({ id: tail.id, updatedAt: isoDate(tail.updatedAt) }) : null,
    };
  }

  public async getPackage(tenantId: string, userId: string, packageId: string): Promise<JsonValue> {
    const scope = await this.scopeForPackage(this.database.client, tenantId, userId, packageId);
    return this.packageDetail(scope, packageId);
  }

  public async generatePackage(
    transaction: TransactionSql,
    tenantId: string,
    userId: string,
    packageId: string,
    expectedVersion: number,
    input: GenerateContentRequest,
    audit: ContentApiAudit,
  ): Promise<JsonValue> {
    const scope = await this.scopeForPackage(transaction, tenantId, userId, packageId);
    await assertRequestedPlatforms(transaction, tenantId, packageId, input.platform_codes);
    const previousVariants = await selectVariants(transaction, tenantId, packageId);
    const runtime = readGenerationRuntime(input.model_policy);
    const writerInput = await buildWriterInput(
      transaction,
      scope,
      packageId,
      input.locked_block_keys,
      input.platform_codes,
    );
    const result = await this.generation.request(
      transaction,
      { audit, scope },
      {
        expectedPackageVersion: expectedVersion,
        modelKey: runtime.modelKey,
        modelPolicy: input.model_policy,
        packageId,
        promptVersionId: runtime.promptVersionId,
        skillVersion: runtime.skillVersion,
        writerInput,
      },
    );
    await insertAudit(
      transaction,
      tenantId,
      userId,
      'content_generation.api_requested',
      'content_package',
      packageId,
      {
        variants: previousVariants.map((variant) => ({
          id: variant.id,
          status: variant.status,
        })),
      },
      {
        master_run_id: result.masterRunId,
        variant_run_ids: result.variantRuns.map((run) => run.runId),
      },
      null,
      audit,
    );
    return runView(await requireRun(transaction, tenantId, result.masterRunId));
  }

  public async abandonPackage(
    transaction: TransactionSql,
    tenantId: string,
    userId: string,
    packageId: string,
    expectedVersion: number,
    reason: string,
    audit: ContentApiAudit,
  ): Promise<JsonValue> {
    const scope = await this.scopeForPackage(transaction, tenantId, userId, packageId);
    const result = await this.packages.abandon(
      transaction,
      scope,
      packageId,
      expectedVersion,
      reason,
      audit,
    );
    return packageView(result.package);
  }

  public async archivePackage(
    transaction: TransactionSql,
    tenantId: string,
    userId: string,
    packageId: string,
    expectedVersion: number,
    reason: string,
    audit: ContentApiAudit,
  ): Promise<JsonValue> {
    await this.scopeForPackage(transaction, tenantId, userId, packageId);
    await assertTenantAdministrator(transaction, tenantId, userId);
    await assertNoActivePackageRuns(transaction, tenantId, packageId);
    const before = await lockPackage(transaction, tenantId, packageId);
    if (!before) throw contentNotFound();
    if (before.version !== expectedVersion) throw contentVersionConflict();
    if (before.status === 'archived' || before.status === 'cancelled') {
      throw contentStateInvalid('Cancelled or archived content cannot be archived');
    }
    const rows = await transaction<ContentPackageView[]>`
      UPDATE content_packages
      SET status = 'archived', version = version + 1
      WHERE id = ${packageId}::uuid AND tenant_id = ${tenantId}::uuid AND version = ${expectedVersion}
      RETURNING
        id, tenant_id AS "tenantId", workspace_id AS "workspaceId", project_id AS "projectId",
        brief_id AS "briefId", status, version,
        master_content_version_id AS "masterContentVersionId", created_by AS "createdBy",
        created_at AS "createdAt", updated_at AS "updatedAt", deleted_at AS "deletedAt"
    `;
    const after = rows[0];
    if (!after) throw contentVersionConflict();
    await insertAudit(
      transaction,
      tenantId,
      userId,
      'content_package.archived',
      'content_package',
      packageId,
      before,
      after,
      reason,
      audit,
    );
    return packageView(after);
  }

  public async reopenPackage(
    transaction: TransactionSql,
    tenantId: string,
    userId: string,
    packageId: string,
    expectedVersion: number,
    input: ReopenVariantsRequest,
    audit: ContentApiAudit,
  ): Promise<JsonValue> {
    const scope = await this.scopeForPackage(transaction, tenantId, userId, packageId);
    await assertReviewer(transaction, tenantId, userId);
    await assertNoActivePackageRuns(transaction, tenantId, packageId);
    const before = await lockPackage(transaction, tenantId, packageId);
    if (!before) throw contentNotFound();
    if (before.version !== expectedVersion) throw contentVersionConflict();
    if (!['approved', 'rejected'].includes(before.status)) {
      throw contentStateInvalid('Only approved or rejected packages may be reopened');
    }
    const selected = await transaction<ContentVariantView[]>`
      SELECT
        id, tenant_id AS "tenantId", package_id AS "packageId", platform_code AS "platformCode",
        current_content_version_id AS "currentContentVersionId", status,
        is_required AS "isRequired", quality_score::text AS "qualityScore", version,
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM content_variants
      WHERE tenant_id = ${tenantId}::uuid AND package_id = ${packageId}::uuid
        AND id = ANY(${input.variant_ids}::uuid[])
      ORDER BY id FOR UPDATE
    `;
    if (selected.length !== input.variant_ids.length) throw contentNotFound();
    if (selected.some((variant) => !['approved', 'review_rejected'].includes(variant.status))) {
      throw contentStateInvalid('Selected variants are not in a review terminal state');
    }
    await transaction`
      UPDATE content_variants
      SET status = CASE WHEN status = 'approved' THEN 'quality_failed' ELSE 'generated' END,
          version = version + 1
      WHERE tenant_id = ${tenantId}::uuid AND package_id = ${packageId}::uuid
        AND id = ANY(${input.variant_ids}::uuid[])
    `;
    const allVariants = await selectVariants(transaction, tenantId, packageId);
    const status = new PackageStatusProjector().project({
      currentStatus: 'generated',
      variants: allVariants,
    });
    const updated = await transaction<{ id: string }[]>`
      UPDATE content_packages SET status = ${status}, version = version + 1
      WHERE id = ${packageId}::uuid AND tenant_id = ${tenantId}::uuid AND version = ${expectedVersion}
      RETURNING id
    `;
    if (updated.length !== 1) throw contentVersionConflict();
    await insertAudit(
      transaction,
      tenantId,
      userId,
      'content_package.reopened',
      'content_package',
      packageId,
      before,
      { status, variant_ids: input.variant_ids },
      input.reason,
      audit,
    );
    return this.packageDetail(scope, packageId, transaction);
  }

  public async getRun(tenantId: string, userId: string, runId: string): Promise<JsonValue> {
    const run = await findScopedRun(this.database.client, tenantId, userId, runId);
    if (!run) throw contentNotFound();
    return runView(run);
  }

  public async cancelRun(
    transaction: TransactionSql,
    tenantId: string,
    userId: string,
    runId: string,
    expectedVersion: number,
    reason: string,
    audit: ContentApiAudit,
  ): Promise<JsonValue> {
    const run = await findScopedRun(transaction, tenantId, userId, runId, true);
    if (!run) throw contentNotFound();
    if (run.version !== expectedVersion) throw contentVersionConflict();
    if (!['queued', 'running'].includes(run.status)) {
      throw contentStateInvalid('Only queued or running generation runs may be cancelled');
    }
    const rows = await transaction<ContentGenerationRunView[]>`
      UPDATE generation_runs
      SET status = 'cancelled', started_at = COALESCE(started_at, now()),
          finished_at = COALESCE(finished_at, now()), version = version + 1,
          error_json = ${JSON.stringify({ code: 'USER_CANCELLED', message: reason })}::text::jsonb
      WHERE id = ${runId}::uuid AND tenant_id = ${tenantId}::uuid
        AND version = ${expectedVersion} AND status IN ('queued', 'running')
      RETURNING
        id, tenant_id AS "tenantId", workspace_id AS "workspaceId", project_id AS "projectId",
        package_id AS "packageId", variant_id AS "variantId", skill_name AS "skillName",
        skill_version AS "skillVersion", prompt_version_id AS "promptVersionId",
        model_key AS "modelKey", status, input_hash AS "inputHash", request_id AS "requestId",
        error_json AS error, started_at AS "startedAt", finished_at AS "finishedAt", version,
        created_at AS "createdAt", updated_at AS "updatedAt"
    `;
    const cancelled = rows[0];
    if (!cancelled) throw contentVersionConflict();
    const restored = await restorePreviousGenerationStatuses(transaction, tenantId, run);
    if (!run.variantId && run.packageId) {
      await transaction`
        UPDATE generation_runs
        SET status = 'cancelled', started_at = COALESCE(started_at, now()),
            finished_at = COALESCE(finished_at, now()), version = version + 1,
            error_json = ${JSON.stringify({ code: 'PARENT_CANCELLED', message: reason })}::text::jsonb
        WHERE tenant_id = ${tenantId}::uuid AND package_id = ${run.packageId}::uuid
          AND id <> ${runId}::uuid AND status IN ('queued', 'running')
      `;
      if (!restored) await restoreGeneratedFallback(transaction, tenantId, run.packageId, null);
    } else if (run.variantId) {
      if (!restored)
        await restoreGeneratedFallback(transaction, tenantId, run.packageId, run.variantId);
    }
    if (run.packageId) await projectPackageStatus(transaction, tenantId, run.packageId);
    await insertAudit(
      transaction,
      tenantId,
      userId,
      'generation_run.cancelled',
      'generation_run',
      runId,
      run,
      cancelled,
      reason,
      audit,
    );
    return runView(cancelled);
  }

  public async getVersion(tenantId: string, userId: string, versionId: string): Promise<JsonValue> {
    const scope = await this.scopeForVersion(this.database.client, tenantId, userId, versionId);
    const version = await this.versions.find(scope, versionId);
    if (!version) throw contentNotFound();
    return versionView(version);
  }

  public async diffVersion(
    tenantId: string,
    userId: string,
    versionId: string,
    targetVersionId: string,
  ): Promise<JsonValue> {
    const scope = await this.scopeForVersion(this.database.client, tenantId, userId, versionId);
    return snake(this.versions.diff(scope, versionId, targetVersionId));
  }

  public async rollbackVersion(
    transaction: TransactionSql,
    tenantId: string,
    userId: string,
    versionId: string,
    expectedVersion: number,
    audit: ContentApiAudit,
  ): Promise<JsonValue> {
    const scope = await this.scopeForVersion(transaction, tenantId, userId, versionId);
    const version = await this.versions.rollback(
      transaction,
      scope,
      versionId,
      expectedVersion,
      audit,
    );
    await markManualContentChange(
      transaction,
      tenantId,
      userId,
      version.packageId,
      version.variantId,
      audit,
    );
    return versionView(version);
  }

  public async getVariant(tenantId: string, userId: string, variantId: string): Promise<JsonValue> {
    const scope = await this.scopeForVariant(this.database.client, tenantId, userId, variantId);
    return this.variantDetail(scope, variantId);
  }

  public async getVariantContentHash(
    tenantId: string,
    userId: string,
    variantId: string,
  ): Promise<string> {
    const scope = await this.scopeForVariant(this.database.client, tenantId, userId, variantId);
    const rows = await this.database.client<{ contentHash: string }[]>`
      SELECT version.content_hash AS "contentHash"
      FROM content_variants AS variant
      JOIN content_versions AS version
        ON version.id = variant.current_content_version_id AND version.tenant_id = variant.tenant_id
      JOIN content_packages AS package
        ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
      WHERE variant.id = ${variantId}::uuid
        AND variant.tenant_id = ${scope.tenantId}::uuid
        AND package.workspace_id = ${scope.workspaceId}::uuid
        AND package.project_id = ${scope.projectId}::uuid
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw contentNotFound();
    return row.contentHash;
  }

  public async updateVariant(
    transaction: TransactionSql,
    tenantId: string,
    userId: string,
    variantId: string,
    expectedVersion: number,
    content: ApiContentDocument,
    audit: ContentApiAudit,
  ): Promise<JsonValue> {
    const scope = await this.scopeForVariant(transaction, tenantId, userId, variantId);
    const variant = await this.variants.find(scope, variantId);
    if (!variant) throw contentNotFound();
    assertManualEditStatus(variant.status);
    await this.versions.create(
      transaction,
      scope,
      {
        contentJson: content as DatabaseContentDocument,
        expectedVersion,
        packageId: variant.packageId,
        schemaVersion: content.schema_version,
        variantId,
      },
      audit,
    );
    await markManualContentChange(
      transaction,
      tenantId,
      userId,
      variant.packageId,
      variantId,
      audit,
    );
    return this.variantDetail(scope, variantId, transaction);
  }

  public async lockBlock(
    transaction: TransactionSql,
    tenantId: string,
    userId: string,
    variantId: string,
    blockId: string,
    expectedVersion: number,
    reason: string | null,
    audit: ContentApiAudit,
  ): Promise<JsonValue> {
    const scope = await this.scopeForVariant(transaction, tenantId, userId, variantId);
    const result = await this.blocks.lock(
      transaction,
      scope,
      variantId,
      blockId,
      expectedVersion,
      reason,
      audit,
    );
    return snake({ ...result.lock, variantVersion: result.variantVersion });
  }

  public async unlockBlock(
    transaction: TransactionSql,
    tenantId: string,
    userId: string,
    variantId: string,
    blockId: string,
    expectedVersion: number,
    audit: ContentApiAudit,
  ): Promise<void> {
    const scope = await this.scopeForVariant(transaction, tenantId, userId, variantId);
    await this.blocks.unlock(transaction, scope, variantId, blockId, expectedVersion, audit);
  }

  public async requestQualityCheck(
    transaction: TransactionSql,
    tenantId: string,
    userId: string,
    variantId: string,
    expectedContentHash: string,
    audit: ContentApiAudit,
  ): Promise<JsonValue> {
    const scope = await this.scopeForVariant(transaction, tenantId, userId, variantId);
    const variant = await lockVariant(transaction, tenantId, variantId);
    if (!variant || !variant.currentContentVersionId) throw contentNotFound();
    if (
      !['generated', 'generation_failed', 'quality_failed', 'quality_passed'].includes(
        variant.status,
      )
    ) {
      throw contentStateInvalid('Variant state does not permit a quality check');
    }
    await assertNoActiveVariantRun(transaction, tenantId, variantId);
    const baijiahaoTerminalRuns = await transaction<{ errorCode: string | null }[]>`
      SELECT automation.last_error_json->>'code' AS "errorCode"
      FROM baijiahao_automation_runs AS automation
      JOIN baijiahao_automation_policies AS policy
        ON policy.id=automation.policy_id AND policy.tenant_id=automation.tenant_id
      WHERE automation.tenant_id=${tenantId}::uuid AND automation.variant_id=${variantId}::uuid
        AND automation.status IN ('manual_required','disabled') AND policy.enabled
    `;
    if (
      baijiahaoTerminalRuns.some(
        ({ errorCode }) => !RECOVERABLE_BAIJIAHAO_MANUAL_CODES.includes(errorCode ?? ''),
      )
    ) {
      throw contentStateInvalid(
        'Baijiahao manual state must be resolved from its publication record',
      );
    }
    const browserPlatformTerminalRuns = await transaction<{ publishJobId: string | null }[]>`
      SELECT automation.publish_job_id AS "publishJobId"
      FROM browser_platform_automation_runs AS automation
      JOIN browser_platform_automation_policies AS policy
        ON policy.id=automation.policy_id AND policy.tenant_id=automation.tenant_id
      WHERE automation.tenant_id=${tenantId}::uuid AND automation.variant_id=${variantId}::uuid
        AND automation.status='manual_required' AND policy.enabled
    `;
    if (browserPlatformTerminalRuns.some(({ publishJobId }) => publishJobId !== null)) {
      throw contentStateInvalid(
        'Browser platform publication state must be resolved from its publication record',
      );
    }
    await transaction`
      UPDATE official_site_automation_runs AS automation SET
        status='quality_pending',content_version_id=${variant.currentContentVersionId}::uuid,
        rewrite_count=0,last_quality_report_id=NULL,
        publish_job_id=NULL,last_error_json=NULL,finished_at=NULL,version=automation.version+1
      FROM official_site_automation_policies AS policy
      WHERE automation.policy_id=policy.id AND automation.tenant_id=policy.tenant_id
        AND automation.tenant_id=${tenantId}::uuid AND automation.variant_id=${variantId}::uuid
        AND automation.status='manual_required' AND policy.enabled
    `;
    const recoveredBaijiahaoRuns = await transaction<{ id: string }[]>`
      UPDATE baijiahao_automation_runs AS automation SET
        status='quality_pending',content_version_id=${variant.currentContentVersionId}::uuid,
        rewrite_count=0,last_quality_report_id=NULL,
        publish_job_id=NULL,last_error_json=NULL,finished_at=NULL,version=automation.version+1
      FROM baijiahao_automation_policies AS policy
      WHERE automation.policy_id=policy.id AND automation.tenant_id=policy.tenant_id
        AND automation.tenant_id=${tenantId}::uuid AND automation.variant_id=${variantId}::uuid
        AND policy.enabled AND automation.publish_job_id IS NULL
        AND (
          automation.status = ANY(
            ${transaction.array([...RECOVERABLE_BAIJIAHAO_CONTENT_STATES], 25)}::text[]
          )
          OR (
            automation.status IN ('manual_required','disabled')
            AND COALESCE(automation.last_error_json->>'code','') = ANY(
              ${transaction.array([...RECOVERABLE_BAIJIAHAO_MANUAL_CODES], 25)}::text[]
            )
          )
        )
      RETURNING automation.id
    `;
    if (recoveredBaijiahaoRuns.length > 0) {
      await transaction`
        UPDATE baijiahao_daily_batch_items AS item SET
          status='quality_check',content_version_id=${variant.currentContentVersionId}::uuid,
          publish_job_id=NULL,scheduled_at=NULL,last_error_json=NULL
        FROM baijiahao_automation_runs AS automation
        WHERE item.automation_run_id=automation.id AND item.tenant_id=automation.tenant_id
          AND automation.tenant_id=${tenantId}::uuid
          AND automation.variant_id=${variantId}::uuid
          AND automation.status='quality_pending'
      `;
    }
    const recoveredBrowserPlatformRuns = await transaction<{ id: string }[]>`
      UPDATE browser_platform_automation_runs AS automation SET
        status='quality_pending',content_version_id=${variant.currentContentVersionId}::uuid,
        rewrite_count=0,last_quality_report_id=NULL,publish_job_id=NULL,
        last_error_json=NULL,finished_at=NULL,version=automation.version+1
      FROM browser_platform_automation_policies AS policy
      WHERE automation.policy_id=policy.id AND automation.tenant_id=policy.tenant_id
        AND automation.tenant_id=${tenantId}::uuid AND automation.variant_id=${variantId}::uuid
        AND automation.status='manual_required' AND policy.enabled
        AND automation.publish_job_id IS NULL
      RETURNING automation.id
    `;
    if (recoveredBrowserPlatformRuns.length > 0) {
      await transaction`
        UPDATE browser_platform_daily_batch_items AS item SET
          status='quality_check',content_version_id=${variant.currentContentVersionId}::uuid,
          publish_job_id=NULL,scheduled_at=NULL,qualified_at=NULL,last_error_json=NULL
        FROM browser_platform_automation_runs AS automation
        WHERE item.automation_run_id=automation.id AND item.tenant_id=automation.tenant_id
          AND automation.tenant_id=${tenantId}::uuid
          AND automation.variant_id=${variantId}::uuid
          AND automation.status='quality_pending'
      `;
      await transaction`
        UPDATE browser_platform_daily_batches AS batch SET
          status='running',last_error_json=NULL,version=batch.version+1
        FROM browser_platform_daily_batch_items AS item,
          browser_platform_automation_runs AS automation,
          browser_platform_automation_policies AS policy
        WHERE item.batch_id=batch.id AND item.tenant_id=batch.tenant_id
          AND automation.id=item.automation_run_id AND automation.tenant_id=item.tenant_id
          AND policy.id=automation.policy_id AND policy.tenant_id=automation.tenant_id
          AND batch.tenant_id=${tenantId}::uuid AND automation.variant_id=${variantId}::uuid
          AND automation.status='quality_pending' AND batch.status='attention_required'
          AND batch.business_date=(now() AT TIME ZONE policy.daily_timezone)::date
          AND NOT EXISTS (
            SELECT 1 FROM browser_platform_daily_batches AS active_batch
            WHERE active_batch.tenant_id=batch.tenant_id
              AND active_batch.policy_id=batch.policy_id
              AND active_batch.business_date=batch.business_date
              AND active_batch.id<>batch.id
              AND active_batch.status IN ('running','scheduled')
          )
      `;
    }
    const runtime = readQualityRuntime();
    const current = await requireContentVersion(
      transaction,
      tenantId,
      variant.currentContentVersionId,
    );
    if (current.contentHash !== expectedContentHash) throw contentVersionConflict();
    const run = await insertGenerationRun(transaction, {
      inputHash: qualityEvaluationInputHash(current.contentHash, runtime),
      modelKey: runtime.modelKey,
      packageId: variant.packageId,
      projectId: scope.projectId,
      promptVersionId: runtime.promptVersionId,
      requestId: audit.requestId,
      skillName: 'quality-checker',
      skillVersion: runtime.skillVersion,
      tenantId,
      variantId,
      workspaceId: scope.workspaceId,
    });
    await this.outbox.enqueue(
      {
        aggregateId: variantId,
        aggregateType: 'content_variant',
        data: {
          actor_user_id: userId,
          content_hash: current.contentHash,
          content_version_id: current.id,
          generation_run_id: run.id,
          package_id: variant.packageId,
          project_id: scope.projectId,
          request_id: audit.requestId,
          variant_id: variantId,
          workspace_id: scope.workspaceId,
        },
        eventType: 'content.variant.quality_check_requested.v1',
        tenantId,
      },
      transaction,
    );
    await insertAudit(
      transaction,
      tenantId,
      userId,
      'content_variant.quality_check_requested',
      'content_variant',
      variantId,
      variant,
      { generation_run_id: run.id },
      null,
      audit,
    );
    return runView(run);
  }

  public async regenerateVariant(
    transaction: TransactionSql,
    tenantId: string,
    userId: string,
    variantId: string,
    expectedVersion: number,
    input: RegenerateVariantRequest,
    audit: ContentApiAudit,
  ): Promise<JsonValue> {
    const scope = await this.scopeForVariant(transaction, tenantId, userId, variantId);
    const variant = await lockVariant(transaction, tenantId, variantId);
    if (!variant) throw contentNotFound();
    if (variant.version !== expectedVersion) throw contentVersionConflict();
    const recoverableAutomationVariant =
      !variant.isRequired &&
      variant.platformCode === 'baijiahao' &&
      (await hasRecoverableBaijiahaoAutomation(transaction, tenantId, variantId));
    if (
      (!variant.isRequired && !recoverableAutomationVariant) ||
      !canRegenerateContentVariant(variant.status)
    ) {
      throw contentStateInvalid('Variant state does not permit regeneration');
    }
    await assertNoActivePackageRuns(transaction, tenantId, variant.packageId);
    const locks = await loadLockedBlocks(transaction, tenantId, variantId, input.locked_block_keys);
    const runtime = readGenerationRuntime(input.model_policy);
    const writerInput = await buildWriterInput(
      transaction,
      scope,
      variant.packageId,
      input.locked_block_keys,
      [variant.platformCode],
    );
    const revision = input.quality_report_id
      ? await loadQualityRewriteSource(
          transaction,
          tenantId,
          variantId,
          variant.currentContentVersionId,
          variant.platformCode,
          input.quality_report_id,
        )
      : null;
    const targetAccountId = generationTargetAccountId(writerInput, variant.platformCode);
    const inputHash = sha256(
      canonicalJson({
        locks,
        revision: revision?.eventData ?? null,
        runtime,
        variant_id: variantId,
        writer_input: writerInput,
      }),
    );
    const master = await insertGenerationRun(transaction, {
      inputHash,
      modelKey: runtime.modelKey,
      packageId: variant.packageId,
      projectId: scope.projectId,
      promptVersionId: runtime.promptVersionId,
      requestId: audit.requestId,
      skillName: 'content-writer',
      skillVersion: runtime.skillVersion,
      tenantId,
      variantId: null,
      workspaceId: scope.workspaceId,
    });
    const run = await insertGenerationRun(transaction, {
      inputHash,
      modelKey: runtime.modelKey,
      packageId: variant.packageId,
      projectId: scope.projectId,
      promptVersionId: runtime.promptVersionId,
      requestId: audit.requestId,
      skillName: 'content-writer',
      skillVersion: runtime.skillVersion,
      tenantId,
      variantId,
      workspaceId: scope.workspaceId,
    });
    const updated = await transaction<{ id: string }[]>`
      UPDATE content_variants
      SET
        status = 'generating',
        platform_account_id = CASE
          WHEN ${targetAccountId !== null}
          THEN ${targetAccountId}::uuid
          ELSE platform_account_id
        END,
        version = version + 1
      WHERE id = ${variantId}::uuid AND tenant_id = ${tenantId}::uuid AND version = ${expectedVersion}
      RETURNING id
    `;
    if (updated.length !== 1) throw contentVersionConflict();
    await transaction`
      UPDATE content_packages SET status = 'generating', version = version + 1
      WHERE id = ${variant.packageId}::uuid AND tenant_id = ${tenantId}::uuid
    `;
    await this.outbox.enqueue(
      {
        aggregateId: variant.packageId,
        aggregateType: 'content_package',
        data: {
          actor_user_id: userId,
          input_hash: inputHash,
          master_run_id: master.id,
          model_key: runtime.modelKey,
          model_policy: input.model_policy,
          package_id: variant.packageId,
          project_id: scope.projectId,
          prompt_version_id: runtime.promptVersionId,
          request_id: audit.requestId,
          ...(revision ? { revision: revision.eventData } : {}),
          skill_version: runtime.skillVersion,
          variant_runs: [
            { platform_code: variant.platformCode, run_id: run.id, variant_id: variantId },
          ],
          workspace_id: scope.workspaceId,
          writer_input: writerInput,
        } as DomainEventEnvelope['data'],
        eventType: 'content.package.generation_requested.v1',
        tenantId,
      },
      transaction,
    );
    await insertAudit(
      transaction,
      tenantId,
      userId,
      'content_variant.regeneration_requested',
      'content_variant',
      variantId,
      variant,
      {
        generation_run_id: run.id,
        ...(input.quality_report_id ? { quality_report_id: input.quality_report_id } : {}),
      },
      null,
      audit,
    );
    return runView(run);
  }

  public async dropVariant(
    transaction: TransactionSql,
    tenantId: string,
    userId: string,
    variantId: string,
    expectedVersion: number,
    reason: string,
    audit: ContentApiAudit,
  ): Promise<JsonValue> {
    const scope = await this.scopeForVariant(transaction, tenantId, userId, variantId);
    const variant = await this.variants.find(scope, variantId);
    if (!variant) throw contentNotFound();
    await this.variants.drop(
      transaction,
      scope,
      variant.packageId,
      variantId,
      expectedVersion,
      reason,
      audit,
    );
    return this.variantDetail(scope, variantId, transaction);
  }

  private async packageDetail(
    scope: ContentScope,
    packageId: string,
    client: SqlClient = this.database.client,
  ): Promise<JsonValue> {
    const packageRepository =
      client === this.database.client
        ? this.packages
        : new ContentPackageRepository(client as IdentityAuthDatabase['client']);
    const versionRepository =
      client === this.database.client
        ? this.versions
        : new ContentVersionRepository(client as IdentityAuthDatabase['client']);
    const aggregate = await packageRepository.find(scope, packageId);
    if (!aggregate) throw contentNotFound();
    const master = aggregate.package.masterContentVersionId
      ? await versionRepository.find(scope, aggregate.package.masterContentVersionId)
      : null;
    const runs = await selectRuns(client, scope, packageId);
    return {
      generation_runs: runs.map(runView),
      master_content: master ? versionView(master) : null,
      package: packageView(aggregate.package),
      variants: aggregate.variants.map(variantView),
    };
  }

  private async variantDetail(
    scope: ContentScope,
    variantId: string,
    client: SqlClient = this.database.client,
  ): Promise<JsonValue> {
    const variant = await selectVariant(client, scope, variantId);
    if (!variant) throw contentNotFound();
    const versions = await selectVersionDetails(client, scope, variant.packageId, variantId);
    const current =
      versions.find((version) => version.id === variant.currentContentVersionId) ?? null;
    const locks = await selectLocks(client, scope, variantId);
    const citations = current ? await selectCitations(client, scope, current.id) : [];
    const reports = await selectQualityReports(client, scope, variantId);
    const report = reports.find((candidate) => candidate.contentVersionId === current?.id) ?? null;
    const automation = await selectAutomationRun(client, scope, variantId);
    return {
      automation_run: automation ? snake(automation) : null,
      citations: citations.map(snake),
      current_content: current ? versionView(current) : null,
      locks: locks.map(snake),
      quality_report: report ? qualityReportView(report) : null,
      quality_reports: reports.map(qualityReportView),
      variant: variantView(variant),
      versions: versions.map(versionView),
    };
  }

  private scopeForPackage(client: SqlClient, tenantId: string, userId: string, id: string) {
    return resolveScope(client, tenantId, userId, 'package', id);
  }

  private scopeForVariant(client: SqlClient, tenantId: string, userId: string, id: string) {
    return resolveScope(client, tenantId, userId, 'variant', id);
  }

  private scopeForVersion(client: SqlClient, tenantId: string, userId: string, id: string) {
    return resolveScope(client, tenantId, userId, 'version', id);
  }
}

async function selectAutomationRun(client: SqlClient, scope: ContentScope, variantId: string) {
  const rows = await client<
    {
      contentVersionId: string | null;
      finishedAt: Date | string | null;
      id: string;
      lastError: Readonly<Record<string, unknown>> | null;
      publishJobId: string | null;
      rewriteCount: number;
      status: string;
      updatedAt: Date | string;
    }[]
  >`
    SELECT automation.id,automation.content_version_id AS "contentVersionId",
      automation.status,automation.rewrite_count AS "rewriteCount",
      automation.publish_job_id AS "publishJobId",automation.last_error_json AS "lastError",
      automation.updated_at AS "updatedAt",automation.finished_at AS "finishedAt"
    FROM (
      SELECT id,tenant_id,variant_id,content_version_id,status,rewrite_count,
        publish_job_id,last_error_json,updated_at,finished_at
      FROM official_site_automation_runs
      WHERE tenant_id=${scope.tenantId}::uuid AND variant_id=${variantId}::uuid
      UNION ALL
      SELECT id,tenant_id,variant_id,content_version_id,status,rewrite_count,
        publish_job_id,last_error_json,updated_at,finished_at
      FROM baijiahao_automation_runs
      WHERE tenant_id=${scope.tenantId}::uuid AND variant_id=${variantId}::uuid
    ) AS automation
    JOIN content_variants AS variant
      ON variant.id=automation.variant_id AND variant.tenant_id=automation.tenant_id
    JOIN content_packages AS package
      ON package.id=variant.package_id AND package.tenant_id=variant.tenant_id
    WHERE automation.tenant_id=${scope.tenantId}::uuid
      AND automation.variant_id=${variantId}::uuid
      AND has_project_scope_access(
        package.tenant_id,package.workspace_id,package.project_id,${scope.userId}::uuid
      )
    LIMIT 1
  `;
  return rows[0];
}

function scopeFromInput(
  tenantId: string,
  userId: string,
  input: { readonly project_id: string; readonly workspace_id: string },
): ContentScope {
  return { projectId: input.project_id, tenantId, userId, workspaceId: input.workspace_id };
}

async function resolveScope(
  client: SqlClient,
  tenantId: string,
  userId: string,
  kind: 'package' | 'variant' | 'version',
  id: string,
): Promise<ContentScope> {
  const rows =
    kind === 'package'
      ? await client<ScopeSeed[]>`
          SELECT workspace_id AS "workspaceId", project_id AS "projectId"
          FROM content_packages
          WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
            AND has_project_scope_access(tenant_id, workspace_id, project_id, ${userId}::uuid)
          LIMIT 1
        `
      : kind === 'variant'
        ? await client<ScopeSeed[]>`
            SELECT package.workspace_id AS "workspaceId", package.project_id AS "projectId"
            FROM content_variants AS variant
            JOIN content_packages AS package ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
            WHERE variant.id = ${id}::uuid AND variant.tenant_id = ${tenantId}::uuid
              AND package.deleted_at IS NULL
              AND has_project_scope_access(package.tenant_id, package.workspace_id, package.project_id, ${userId}::uuid)
            LIMIT 1
          `
        : await client<ScopeSeed[]>`
            SELECT package.workspace_id AS "workspaceId", package.project_id AS "projectId"
            FROM content_versions AS version
            JOIN content_packages AS package ON package.id = version.package_id AND package.tenant_id = version.tenant_id
            WHERE version.id = ${id}::uuid AND version.tenant_id = ${tenantId}::uuid
              AND package.deleted_at IS NULL
              AND has_project_scope_access(package.tenant_id, package.workspace_id, package.project_id, ${userId}::uuid)
            LIMIT 1
          `;
  const scope = rows[0];
  if (!scope) throw contentNotFound();
  return { ...scope, tenantId, userId };
}

async function assertRequestedPlatforms(
  client: SqlClient,
  tenantId: string,
  packageId: string,
  requested: readonly PlatformCode[],
): Promise<void> {
  const rows = await client<{ platformCode: PlatformCode }[]>`
    SELECT platform_code AS "platformCode" FROM content_variants
    WHERE tenant_id = ${tenantId}::uuid AND package_id = ${packageId}::uuid AND is_required
    ORDER BY platform_code
  `;
  const actual = rows.map((row) => row.platformCode).sort();
  const expected = [...requested].sort();
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw contentValidationInvalid('platform_codes must match all required package variants');
  }
}

async function buildWriterInput(
  client: SqlClient,
  scope: ContentScope,
  packageId: string,
  lockedBlockKeys: readonly string[],
  platformCodes: readonly PlatformCode[],
): Promise<Record<string, JsonValue>> {
  const briefRows = await client<
    {
      audience: string;
      briefId: string;
      constraints: Record<string, JsonValue>;
      generationMode: string;
      objective: string;
      platformCodes: readonly PlatformCode[];
      title: string;
    }[]
  >`
    SELECT brief.id AS "briefId", brief.title, brief.objective, brief.audience,
      brief.platform_codes AS "platformCodes", brief.constraints_json AS constraints,
      brief.generation_mode AS "generationMode"
    FROM content_packages AS package
    JOIN briefs AS brief ON brief.id = package.brief_id AND brief.tenant_id = package.tenant_id
    WHERE package.id = ${packageId}::uuid AND package.tenant_id = ${scope.tenantId}::uuid
      AND package.workspace_id = ${scope.workspaceId}::uuid AND package.project_id = ${scope.projectId}::uuid
    LIMIT 1
  `;
  const brandRows = await client<
    { id: string; profile: Record<string, JsonValue>; version: number }[]
  >`
    SELECT id, profile_json AS profile, version FROM brand_profiles
    WHERE tenant_id = ${scope.tenantId}::uuid AND workspace_id = ${scope.workspaceId}::uuid
      AND status = 'published'
    ORDER BY version DESC LIMIT 1
  `;
  const brief = briefRows[0];
  const brand = brandRows[0];
  if (!brief || !brand)
    throw contentStateInvalid('Published brand strategy and Brief are required');
  const sourceRows = await client<{ sourceId: string }[]>`
    SELECT DISTINCT source.id AS "sourceId"
    FROM content_packages AS package
    JOIN brief_sources AS link
      ON link.brief_id = package.brief_id
      AND link.tenant_id = package.tenant_id
    JOIN source_documents AS source
      ON source.id = link.source_document_id
      AND source.tenant_id = link.tenant_id
    WHERE package.id = ${packageId}::uuid
      AND package.tenant_id = ${scope.tenantId}::uuid
      AND package.workspace_id = ${scope.workspaceId}::uuid
      AND package.project_id = ${scope.projectId}::uuid
      AND source.deleted_at IS NULL
    ORDER BY source.id
  `;
  const citations = await retrieveWriterCitations(client, scope, packageId, brief, sourceRows);
  const rules = readPlatformRules(platformCodes);
  const targetAccounts =
    process.env['CONTENT_REQUIRE_PLATFORM_ACCOUNTS'] === 'true'
      ? await loadGenerationTargetAccounts(client, scope, platformCodes)
      : {};
  const locked = await loadLockedBlocks(client, scope.tenantId, null, lockedBlockKeys, packageId);
  return {
    brief: {
      audience: brief.audience,
      brief_id: brief.briefId,
      constraints: {
        ...brief.constraints,
        ...(Object.keys(targetAccounts).length > 0
          ? { target_accounts_by_code: targetAccounts }
          : {}),
      },
      objective: brief.objective,
      platform_codes: platformCodes,
      title: brief.title,
    },
    citations,
    generation_mode: brief.generationMode,
    locked_blocks: locked,
    platform_rules_by_code: rules,
    strategy: { brand_profile_id: brand.id, profile: brand.profile, version: brand.version },
  };
}

async function retrieveWriterCitations(
  client: SqlClient,
  scope: ContentScope,
  packageId: string,
  brief: {
    readonly audience: string;
    readonly objective: string;
    readonly title: string;
  },
  sources: readonly { readonly sourceId: string }[],
): Promise<readonly Record<string, JsonValue>[]> {
  if (sources.length === 0) return [];
  const keywordRows = await client<{ term: string }[]>`
    SELECT keyword.term
    FROM content_packages AS package
    JOIN brief_keywords AS link
      ON link.brief_id = package.brief_id
      AND link.tenant_id = package.tenant_id
    JOIN keywords AS keyword
      ON keyword.id = link.keyword_id
      AND keyword.tenant_id = link.tenant_id
    WHERE package.id = ${packageId}::uuid
      AND package.tenant_id = ${scope.tenantId}::uuid
      AND keyword.status = 'active'
    ORDER BY link.is_primary DESC, keyword.priority DESC, keyword.id
    LIMIT 20
  `;
  const query = [
    brief.title,
    brief.objective,
    brief.audience,
    ...keywordRows.map((row) => row.term),
  ]
    .join(' ')
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 500);
  const embeddingConfig = readEmbeddingConfiguration({
    ...process.env,
    EMBEDDING_DRIVER: process.env['EMBEDDING_DRIVER'] ?? 'local',
    EMBEDDING_MODEL_KEY: process.env['EMBEDDING_MODEL_KEY'] ?? 'embedding-local-ngram-v1',
  });
  const embedding = createEmbeddingAdapter(embeddingConfig);
  const inputId = `query-${packageId}`;
  const embedded = await embedding.embedBatch({
    inputs: [{ id: inputId, text: query, textHash: sha256(query) }],
    requestId: `citation-embedding-${packageId}`,
  });
  const vector = embedded.embeddings[0];
  if (!vector) throw contentStateInvalid('Knowledge query embedding could not be generated');
  const rerankConfig = readRerankConfiguration({
    ...process.env,
    RERANK_DRIVER: process.env['RERANK_DRIVER'] ?? 'local',
    RERANK_MODEL_KEY: process.env['RERANK_MODEL_KEY'] ?? 'rerank-local-ngram-v1',
  });
  const context = await new CitationSearchService(
    new HybridSearchRepository(client),
    createRerankAdapter(rerankConfig),
  ).search({
    embeddingModelKey: embedding.modelKey,
    query,
    queryEmbedding: vector.vector,
    requestId: `citation-search-${packageId}`,
    scope: {
      projectId: scope.projectId,
      tenantId: scope.tenantId,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
    },
    sourceDocumentIds: sources.map((source) => source.sourceId),
  });
  return context.hits.map((hit) => ({
    chunk_id: hit.chunkId,
    citation_id: hit.chunkId,
    quote_text: hit.text,
    source_id: hit.sourceDocumentId,
  }));
}

async function loadGenerationTargetAccounts(
  client: SqlClient,
  scope: ContentScope,
  platformCodes: readonly PlatformCode[],
): Promise<Record<string, JsonValue>> {
  const rows = await client<
    {
      capabilities: Record<string, JsonValue>;
      displayName: string;
      id: string;
      platformCode: PlatformCode;
      providerAccountId: string | null;
      timezone: string;
    }[]
  >`
    SELECT
      account.id,
      account.platform_code AS "platformCode",
      account.display_name AS "displayName",
      account.provider_account_id AS "providerAccountId",
      account.timezone,
      account.capabilities_json AS capabilities
    FROM platform_accounts AS account
    WHERE
      account.tenant_id = ${scope.tenantId}::uuid
      AND account.workspace_id = ${scope.workspaceId}::uuid
      AND account.platform_code = ANY(${platformCodes}::varchar[])
      AND account.status = 'active'
      AND account.deleted_at IS NULL
    ORDER BY account.platform_code, account.id
  `;
  const targets: Record<string, JsonValue> = {};
  for (const platformCode of platformCodes) {
    const candidates = rows.filter((row) => row.platformCode === platformCode);
    if (candidates.length !== 1) {
      throw contentStateInvalid(
        `Platform ${platformCode} requires exactly one active account before generation`,
      );
    }
    const account = candidates[0]!;
    targets[platformCode] = {
      account_id: account.id,
      capabilities: account.capabilities,
      display_name: account.displayName,
      provider_account_id: account.providerAccountId,
      timezone: account.timezone,
    };
  }
  return targets;
}

function generationTargetAccountId(
  writerInput: Readonly<Record<string, JsonValue>>,
  platformCode: PlatformCode,
): string | null {
  if (process.env['CONTENT_REQUIRE_PLATFORM_ACCOUNTS'] !== 'true') return null;
  const brief = jsonRecord(writerInput['brief']);
  const constraints = jsonRecord(brief?.['constraints']);
  const targets = jsonRecord(constraints?.['target_accounts_by_code']);
  const target = jsonRecord(targets?.[platformCode]);
  const accountId = target?.['account_id'];
  if (typeof accountId !== 'string') {
    throw contentStateInvalid(`Platform ${platformCode} target account is invalid`);
  }
  return accountId;
}

function jsonRecord(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, JsonValue>>)
    : null;
}

function readPlatformRules(platformCodes: readonly PlatformCode[]): Record<string, JsonValue> {
  const raw = process.env['CONTENT_PLATFORM_RULES_JSON'];
  if (!raw) {
    if (process.env['NODE_ENV'] === 'production') {
      throw contentStateInvalid('CONTENT_PLATFORM_RULES_JSON is not configured');
    }
    return Object.fromEntries(
      platformCodes.map((code, index) => [
        code,
        {
          rules: {
            platform_code: code,
            require_citations: code !== 'official_site',
            ...(code === 'official_site'
              ? {
                  accepted_first_party_source: 'published_brand_profile',
                  first_party_claims_require_public_citations: false,
                  require_citations_for_external_claims: true,
                }
              : {}),
            schema_version: 'platform-rules@1',
          },
          rules_hash: createHash('sha256').update(`local:${code}`).digest('hex'),
          version_id: `26000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        },
      ]),
    );
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, JsonValue>;
    const selected: Record<string, JsonValue> = {};
    for (const code of platformCodes) {
      const rule = parsed[code];
      if (!rule) throw new Error(`Missing ${code}`);
      selected[code] = rule;
    }
    return selected;
  } catch {
    throw contentStateInvalid('CONTENT_PLATFORM_RULES_JSON is invalid or incomplete');
  }
}

function readGenerationRuntime(policy: GenerateContentRequest['model_policy']): GenerationRuntime {
  const modelKey = process.env[`CONTENT_MODEL_${policy.toUpperCase()}_KEY`];
  const promptVersionId = process.env['CONTENT_WRITER_PROMPT_VERSION_ID'];
  if (!modelKey || !promptVersionId) {
    throw contentStateInvalid('Content generation runtime is not configured');
  }
  return {
    modelKey,
    promptVersionId,
    skillVersion: process.env['CONTENT_WRITER_SKILL_VERSION'] ?? '1.0.0',
  };
}

function readQualityRuntime(): GenerationRuntime {
  const modelKey = process.env['QUALITY_CHECKER_MODEL_KEY'];
  const promptVersionId = process.env['QUALITY_CHECKER_PROMPT_VERSION_ID'];
  if (!modelKey || !promptVersionId) {
    throw contentStateInvalid('Quality checker runtime is not configured');
  }
  return {
    modelKey,
    promptVersionId,
    skillVersion: process.env['QUALITY_CHECKER_SKILL_VERSION'] ?? '1.0.0',
  };
}

async function loadLockedBlocks(
  client: SqlClient,
  tenantId: string,
  variantId: string | null,
  requested: readonly string[],
  packageId?: string,
): Promise<readonly JsonValue[]> {
  if (requested.length === 0) return [];
  const rows = await client<
    {
      blockKey: string;
      citationIds: readonly string[];
      platformCode: PlatformCode;
      text: string;
    }[]
  >`
    SELECT lock.block_key AS "blockKey", variant.platform_code AS "platformCode",
      block_item->>'text' AS text,
      ARRAY(
        SELECT DISTINCT citation.chunk_id
        FROM ai_citations AS citation
        WHERE citation.tenant_id = lock.tenant_id
          AND citation.content_version_id = version.id
          AND citation.claim_text = block_item->>'text'
        ORDER BY citation.chunk_id
      ) AS "citationIds"
    FROM content_block_locks AS lock
    JOIN content_variants AS variant ON variant.id = lock.variant_id AND variant.tenant_id = lock.tenant_id
    JOIN content_versions AS version ON version.id = variant.current_content_version_id AND version.tenant_id = variant.tenant_id
    JOIN LATERAL jsonb_array_elements(version.content_json->'blocks') AS block_item
      ON block_item->>'block_key' = lock.block_key
    WHERE lock.tenant_id = ${tenantId}::uuid
      AND (${variantId}::uuid IS NULL OR lock.variant_id = ${variantId}::uuid)
      AND (${packageId ?? null}::uuid IS NULL OR variant.package_id = ${packageId ?? null}::uuid)
      AND lock.block_key = ANY(${requested}::text[])
    ORDER BY variant.platform_code, lock.block_key
  `;
  if (new Set(rows.map((row) => row.blockKey)).size !== requested.length) {
    throw contentValidationInvalid('locked_block_keys must reference existing locked blocks');
  }
  return rows.map((row) => ({
    block_key: row.blockKey,
    citation_ids: row.citationIds,
    platform_code: row.platformCode,
    text: row.text,
  }));
}

async function findScopedRun(
  client: SqlClient,
  tenantId: string,
  userId: string,
  runId: string,
  lock = false,
): Promise<ContentGenerationRunView | undefined> {
  const rows = await client<ContentGenerationRunView[]>`
    SELECT run.id, run.tenant_id AS "tenantId", run.workspace_id AS "workspaceId",
      run.project_id AS "projectId", run.package_id AS "packageId", run.variant_id AS "variantId",
      run.skill_name AS "skillName", run.skill_version AS "skillVersion",
      run.prompt_version_id AS "promptVersionId", run.model_key AS "modelKey", run.status,
      run.input_hash AS "inputHash", run.request_id AS "requestId", run.error_json AS error,
      run.started_at AS "startedAt", run.finished_at AS "finishedAt", run.version,
      run.created_at AS "createdAt", run.updated_at AS "updatedAt"
    FROM generation_runs AS run
    WHERE run.id = ${runId}::uuid AND run.tenant_id = ${tenantId}::uuid
      AND run.project_id IS NOT NULL
      AND has_project_scope_access(run.tenant_id, run.workspace_id, run.project_id, ${userId}::uuid)
    LIMIT 1
    ${lock ? client`FOR UPDATE OF run` : client``}
  `;
  return rows[0];
}

async function requireRun(client: SqlClient, tenantId: string, runId: string) {
  const rows = await client<ContentGenerationRunView[]>`
    SELECT id, tenant_id AS "tenantId", workspace_id AS "workspaceId", project_id AS "projectId",
      package_id AS "packageId", variant_id AS "variantId", skill_name AS "skillName",
      skill_version AS "skillVersion", prompt_version_id AS "promptVersionId", model_key AS "modelKey",
      status, input_hash AS "inputHash", request_id AS "requestId", error_json AS error,
      started_at AS "startedAt", finished_at AS "finishedAt", version,
      created_at AS "createdAt", updated_at AS "updatedAt"
    FROM generation_runs WHERE id = ${runId}::uuid AND tenant_id = ${tenantId}::uuid LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw contentNotFound();
  return row;
}

interface RunInsert {
  readonly inputHash: string;
  readonly modelKey: string;
  readonly packageId: string;
  readonly projectId: string;
  readonly promptVersionId: string;
  readonly requestId: string;
  readonly skillName: string;
  readonly skillVersion: string;
  readonly tenantId: string;
  readonly variantId: string | null;
  readonly workspaceId: string;
}

async function insertGenerationRun(client: TransactionSql, input: RunInsert) {
  const rows = await client<ContentGenerationRunView[]>`
    INSERT INTO generation_runs (
      tenant_id, workspace_id, project_id, package_id, variant_id, skill_name,
      skill_version, prompt_version_id, model_key, input_hash, request_id
    ) VALUES (
      ${input.tenantId}::uuid, ${input.workspaceId}::uuid, ${input.projectId}::uuid,
      ${input.packageId}::uuid, ${input.variantId}::uuid, ${input.skillName}, ${input.skillVersion},
      ${input.promptVersionId}::uuid, ${input.modelKey}, ${input.inputHash}, ${input.requestId}
    )
    RETURNING id, tenant_id AS "tenantId", workspace_id AS "workspaceId", project_id AS "projectId",
      package_id AS "packageId", variant_id AS "variantId", skill_name AS "skillName",
      skill_version AS "skillVersion", prompt_version_id AS "promptVersionId", model_key AS "modelKey",
      status, input_hash AS "inputHash", request_id AS "requestId", error_json AS error,
      started_at AS "startedAt", finished_at AS "finishedAt", version,
      created_at AS "createdAt", updated_at AS "updatedAt"
  `;
  const row = rows[0];
  if (!row) throw new Error('Generation run insert returned no row');
  return row;
}

async function lockPackage(client: TransactionSql, tenantId: string, packageId: string) {
  const rows = await client<ContentPackageView[]>`
    SELECT id, tenant_id AS "tenantId", workspace_id AS "workspaceId", project_id AS "projectId",
      brief_id AS "briefId", status, version, master_content_version_id AS "masterContentVersionId",
      created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt",
      deleted_at AS "deletedAt"
    FROM content_packages WHERE id = ${packageId}::uuid AND tenant_id = ${tenantId}::uuid
      AND deleted_at IS NULL FOR UPDATE
  `;
  return rows[0];
}

async function lockVariant(client: TransactionSql, tenantId: string, variantId: string) {
  const rows = await client<ContentVariantView[]>`
    SELECT id, tenant_id AS "tenantId", package_id AS "packageId", platform_code AS "platformCode",
      current_content_version_id AS "currentContentVersionId", status, is_required AS "isRequired",
      quality_score::text AS "qualityScore", version, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM content_variants WHERE id = ${variantId}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE
  `;
  return rows[0];
}

async function assertNoActivePackageRuns(client: SqlClient, tenantId: string, packageId: string) {
  const rows = await client<{ id: string }[]>`
    SELECT id FROM generation_runs WHERE tenant_id = ${tenantId}::uuid
      AND package_id = ${packageId}::uuid AND status IN ('queued', 'running') LIMIT 1
  `;
  if (rows.length > 0) throw contentStateInvalid('Package has an active generation run');
}

async function assertNoActiveVariantRun(client: SqlClient, tenantId: string, variantId: string) {
  const rows = await client<{ id: string }[]>`
    SELECT id FROM generation_runs WHERE tenant_id = ${tenantId}::uuid
      AND variant_id = ${variantId}::uuid AND status IN ('queued', 'running') LIMIT 1
  `;
  if (rows.length > 0) throw contentStateInvalid('Variant has an active generation run');
}

async function hasRecoverableBaijiahaoAutomation(
  client: SqlClient,
  tenantId: string,
  variantId: string,
): Promise<boolean> {
  const rows = await client<{ id: string }[]>`
    SELECT automation.id
    FROM baijiahao_automation_runs AS automation
    JOIN baijiahao_automation_policies AS policy
      ON policy.id=automation.policy_id AND policy.tenant_id=automation.tenant_id
      AND policy.enabled
    WHERE automation.tenant_id=${tenantId}::uuid
      AND automation.variant_id=${variantId}::uuid
      AND automation.publish_job_id IS NULL
      AND (
        automation.status = ANY(
          ${client.array([...RECOVERABLE_BAIJIAHAO_CONTENT_STATES], 25)}::text[]
        )
        OR (
          automation.status IN ('manual_required','disabled')
          AND COALESCE(automation.last_error_json->>'code','') = ANY(
            ${client.array([...RECOVERABLE_BAIJIAHAO_MANUAL_CODES], 25)}::text[]
          )
        )
      )
    LIMIT 1
  `;
  return rows.length === 1;
}

const MANUAL_EDIT_STATUSES = new Set<ContentVariantStatus>([
  'approved',
  'generated',
  'published',
  'quality_failed',
  'quality_passed',
  'review_rejected',
]);

function assertManualEditStatus(status: ContentVariantStatus): void {
  if (!MANUAL_EDIT_STATUSES.has(status)) {
    throw contentStateInvalid('Variant state does not permit a manual content version');
  }
}

async function markManualContentChange(
  client: TransactionSql,
  tenantId: string,
  userId: string,
  packageId: string,
  variantId: string | null,
  audit: ContentApiAudit,
): Promise<void> {
  if (variantId) {
    const rows = await client<{ status: ContentVariantStatus }[]>`
      SELECT status FROM content_variants
      WHERE id = ${variantId}::uuid AND tenant_id = ${tenantId}::uuid
        AND package_id = ${packageId}::uuid
      FOR UPDATE
    `;
    const current = rows[0];
    if (!current) throw contentNotFound();
    assertManualEditStatus(current.status);
    const status = ['approved', 'published', 'quality_passed'].includes(current.status)
      ? 'quality_failed'
      : current.status === 'review_rejected'
        ? 'generated'
        : current.status;
    await client`
      UPDATE content_variants SET status = ${status}, quality_score = NULL
      WHERE id = ${variantId}::uuid AND tenant_id = ${tenantId}::uuid
        AND package_id = ${packageId}::uuid
    `;
  }
  const beforeRows = await client<{ status: ContentPackageView['status']; version: number }[]>`
    SELECT status, version FROM content_packages
    WHERE id = ${packageId}::uuid AND tenant_id = ${tenantId}::uuid
    FOR UPDATE
  `;
  const before = beforeRows[0];
  if (!before) throw contentNotFound();
  const afterRows = await client<{ status: ContentPackageView['status']; version: number }[]>`
    UPDATE content_packages
    SET status = 'editing', version = version + ${variantId === null ? 0 : 1}
    WHERE id = ${packageId}::uuid AND tenant_id = ${tenantId}::uuid
      AND status NOT IN ('cancelled', 'archived')
    RETURNING status, version
  `;
  const after = afterRows[0];
  if (!after) throw contentStateInvalid('Package state does not permit manual content changes');
  await insertAudit(
    client,
    tenantId,
    userId,
    'content_package.manual_edit_started',
    'content_package',
    packageId,
    before,
    after,
    null,
    audit,
  );
}

const CANCELLATION_TARGETS = new Set<ContentVariantStatus>([
  'approved',
  'draft',
  'generated',
  'generation_failed',
  'published',
  'publish_failed',
  'quality_failed',
  'quality_passed',
  'review_approved',
  'review_rejected',
]);

async function restorePreviousGenerationStatuses(
  client: TransactionSql,
  tenantId: string,
  run: ContentGenerationRunView,
): Promise<boolean> {
  if (!run.packageId) return false;
  const packageAudits = await client<
    { before: { variants?: readonly { id?: unknown; status?: unknown }[] } | null }[]
  >`
    SELECT before_json AS before
    FROM audit_events
    WHERE tenant_id = ${tenantId}::uuid
      AND request_id = ${run.requestId}
      AND action = 'content_generation.api_requested'
      AND resource_type = 'content_package'
      AND resource_id = ${run.packageId}::uuid
    ORDER BY created_at DESC, id DESC LIMIT 1
  `;
  const candidates = packageAudits[0]?.before?.variants ?? [];
  const selected = run.variantId
    ? candidates.filter((candidate) => candidate.id === run.variantId)
    : candidates;
  let restored = 0;
  for (const candidate of selected) {
    if (
      typeof candidate.id !== 'string' ||
      typeof candidate.status !== 'string' ||
      !CANCELLATION_TARGETS.has(candidate.status as ContentVariantStatus)
    ) {
      continue;
    }
    const rows = await client<{ id: string }[]>`
      UPDATE content_variants
      SET status = ${candidate.status}, version = version + 1
      WHERE id = ${candidate.id}::uuid AND tenant_id = ${tenantId}::uuid
        AND package_id = ${run.packageId}::uuid AND status = 'generating'
      RETURNING id
    `;
    restored += rows.length;
  }
  if (restored > 0) return true;
  if (!run.variantId) return false;

  const variantAudits = await client<{ before: { status?: unknown } | null }[]>`
    SELECT before_json AS before
    FROM audit_events
    WHERE tenant_id = ${tenantId}::uuid
      AND request_id = ${run.requestId}
      AND action = 'content_variant.regeneration_requested'
      AND resource_type = 'content_variant'
      AND resource_id = ${run.variantId}::uuid
    ORDER BY created_at DESC, id DESC LIMIT 1
  `;
  const previousStatus = variantAudits[0]?.before?.status;
  if (
    typeof previousStatus !== 'string' ||
    !CANCELLATION_TARGETS.has(previousStatus as ContentVariantStatus)
  ) {
    return false;
  }
  const rows = await client<{ id: string }[]>`
    UPDATE content_variants SET status = ${previousStatus}, version = version + 1
    WHERE id = ${run.variantId}::uuid AND tenant_id = ${tenantId}::uuid
      AND package_id = ${run.packageId}::uuid AND status = 'generating'
    RETURNING id
  `;
  return rows.length === 1;
}

async function restoreGeneratedFallback(
  client: TransactionSql,
  tenantId: string,
  packageId: string | null,
  variantId: string | null,
): Promise<void> {
  if (!packageId) return;
  await client`
    UPDATE content_variants
    SET status = CASE WHEN current_content_version_id IS NULL THEN 'draft' ELSE 'generated' END,
        version = version + 1
    WHERE tenant_id = ${tenantId}::uuid AND package_id = ${packageId}::uuid
      AND (${variantId}::uuid IS NULL OR id = ${variantId}::uuid)
      AND status = 'generating'
  `;
}

async function assertTenantAdministrator(client: SqlClient, tenantId: string, userId: string) {
  const rows = await client<{ valid: boolean }[]>`
    SELECT true AS valid FROM memberships WHERE tenant_id = ${tenantId}::uuid
      AND user_id = ${userId}::uuid AND status = 'active'
      AND role_code IN ('tenant_owner', 'tenant_admin') LIMIT 1
  `;
  if (rows.length !== 1) throw contentNotFound();
}

async function assertReviewer(client: SqlClient, tenantId: string, userId: string) {
  const rows = await client<{ valid: boolean }[]>`
    SELECT true AS valid FROM memberships WHERE tenant_id = ${tenantId}::uuid
      AND user_id = ${userId}::uuid AND status = 'active'
      AND role_code IN ('tenant_owner', 'tenant_admin', 'reviewer') LIMIT 1
  `;
  if (rows.length !== 1) throw contentNotFound();
}

async function projectPackageStatus(client: TransactionSql, tenantId: string, packageId: string) {
  const variants = await selectVariants(client, tenantId, packageId);
  const packageRows = await client<{ status: ContentPackageView['status'] }[]>`
    SELECT status FROM content_packages WHERE id = ${packageId}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE
  `;
  const current = packageRows[0];
  if (!current) return;
  const status = new PackageStatusProjector().project({ currentStatus: current.status, variants });
  await client`
    UPDATE content_packages SET status = ${status}, version = version + 1
    WHERE id = ${packageId}::uuid AND tenant_id = ${tenantId}::uuid
  `;
}

async function selectVariants(client: SqlClient, tenantId: string, packageId: string) {
  return client<ContentVariantView[]>`
    SELECT id, tenant_id AS "tenantId", package_id AS "packageId", platform_code AS "platformCode",
      current_content_version_id AS "currentContentVersionId", status, is_required AS "isRequired",
      quality_score::text AS "qualityScore", version, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM content_variants WHERE tenant_id = ${tenantId}::uuid AND package_id = ${packageId}::uuid ORDER BY id
  `;
}

async function selectVariant(client: SqlClient, scope: ContentScope, variantId: string) {
  const rows = await client<ContentVariantView[]>`
    SELECT variant.id, variant.tenant_id AS "tenantId", variant.package_id AS "packageId",
      variant.platform_code AS "platformCode", variant.current_content_version_id AS "currentContentVersionId",
      variant.status, variant.is_required AS "isRequired", variant.quality_score::text AS "qualityScore",
      variant.version, variant.created_at AS "createdAt", variant.updated_at AS "updatedAt"
    FROM content_variants AS variant
    JOIN content_packages AS package ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
    WHERE variant.id = ${variantId}::uuid AND variant.tenant_id = ${scope.tenantId}::uuid
      AND package.workspace_id = ${scope.workspaceId}::uuid AND package.project_id = ${scope.projectId}::uuid
      AND package.deleted_at IS NULL
      AND has_project_scope_access(package.tenant_id, package.workspace_id, package.project_id, ${scope.userId}::uuid)
    LIMIT 1
  `;
  return rows[0];
}

async function selectRuns(client: SqlClient, scope: ContentScope, packageId: string) {
  return client<ContentGenerationRunView[]>`
    SELECT run.id, run.tenant_id AS "tenantId", run.workspace_id AS "workspaceId",
      run.project_id AS "projectId", run.package_id AS "packageId", run.variant_id AS "variantId",
      run.skill_name AS "skillName", run.skill_version AS "skillVersion",
      run.prompt_version_id AS "promptVersionId", run.model_key AS "modelKey", run.status,
      run.input_hash AS "inputHash", run.request_id AS "requestId", run.error_json AS error,
      run.started_at AS "startedAt", run.finished_at AS "finishedAt", run.version,
      run.created_at AS "createdAt", run.updated_at AS "updatedAt"
    FROM generation_runs AS run
    WHERE run.tenant_id = ${scope.tenantId}::uuid AND run.package_id = ${packageId}::uuid
      AND run.workspace_id = ${scope.workspaceId}::uuid AND run.project_id = ${scope.projectId}::uuid
    ORDER BY run.created_at DESC, run.id
  `;
}

async function selectVersionDetails(
  client: SqlClient,
  scope: ContentScope,
  packageId: string,
  variantId: string,
) {
  const repository = new ContentVersionRepository(client as IdentityAuthDatabase['client']);
  return repository.list(scope, packageId, variantId);
}

async function selectLocks(client: SqlClient, scope: ContentScope, variantId: string) {
  const repository = new ContentBlockLockRepository(client as IdentityAuthDatabase['client']);
  return repository.list(scope, variantId);
}

async function selectCitations(client: SqlClient, scope: ContentScope, versionId: string) {
  const repository = new ContentRepository(client as IdentityAuthDatabase['client']);
  return repository.listCitations(scope, versionId);
}

async function selectQualityReports(client: SqlClient, scope: ContentScope, variantId: string) {
  const rows = await client<QualityReportRow[]>`
    SELECT report.id, report.tenant_id AS "tenantId", report.variant_id AS "variantId",
      report.content_version_id AS "contentVersionId", report.generation_run_id AS "generationRunId",
      report.checker_version AS "checkerVersion", report.score::text AS score, report.decision,
      report.issues_json AS "issuesJson", report.geo_scores_json AS "geoScoresJson",
      report.automation_gate_json AS "automationGateJson",
      report.created_at AS "createdAt"
    FROM quality_reports AS report
    JOIN content_variants AS variant ON variant.id = report.variant_id AND variant.tenant_id = report.tenant_id
    JOIN content_packages AS package ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
    WHERE report.tenant_id = ${scope.tenantId}::uuid AND report.variant_id = ${variantId}::uuid
      AND package.workspace_id = ${scope.workspaceId}::uuid AND package.project_id = ${scope.projectId}::uuid
      AND has_project_scope_access(package.tenant_id, package.workspace_id, package.project_id, ${scope.userId}::uuid)
    ORDER BY report.created_at DESC, report.id DESC
  `;
  return rows;
}

async function loadQualityRewriteSource(
  client: SqlClient,
  tenantId: string,
  variantId: string,
  currentContentVersionId: string | null,
  platformCode: PlatformCode,
  qualityReportId: string,
) {
  if (!currentContentVersionId) {
    throw contentStateInvalid('A current content version is required for quality-guided rewrite');
  }
  const rows = await client<QualityRewriteRow[]>`
    SELECT report.id, report.tenant_id AS "tenantId", report.variant_id AS "variantId",
      report.content_version_id AS "contentVersionId", report.generation_run_id AS "generationRunId",
      report.checker_version AS "checkerVersion", report.score::text AS score, report.decision,
      report.issues_json AS "issuesJson", report.geo_scores_json AS "geoScoresJson",
      report.automation_gate_json AS "automationGateJson", report.created_at AS "createdAt",
      version.content_json AS content, version.content_hash AS "contentHash",
      run.input_hash AS "inputHash"
    FROM quality_reports AS report
    JOIN content_versions AS version
      ON version.id=report.content_version_id AND version.tenant_id=report.tenant_id
    JOIN generation_runs AS run
      ON run.id=report.generation_run_id AND run.tenant_id=report.tenant_id
      AND run.skill_name='quality-checker'
    WHERE report.id=${qualityReportId}::uuid
      AND report.tenant_id=${tenantId}::uuid
      AND report.variant_id=${variantId}::uuid
      AND report.content_version_id=${currentContentVersionId}::uuid
      AND report.id=(
        SELECT latest.id FROM quality_reports AS latest
        WHERE latest.tenant_id=${tenantId}::uuid
          AND latest.variant_id=${variantId}::uuid
          AND latest.content_version_id=${currentContentVersionId}::uuid
        ORDER BY latest.created_at DESC, latest.id DESC
        LIMIT 1
      )
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    throw contentStateInvalid(
      'Quality report must be the latest report for the current content version',
    );
  }
  const expectedInputHash = qualityEvaluationInputHash(row.contentHash, readQualityRuntime());
  if (row.inputHash !== expectedInputHash) {
    throw contentStateInvalid(
      'Quality report was produced by an outdated checker policy; run a new quality check',
    );
  }
  if (row.decision === 'pass' && row.automationGateJson?.['passed'] !== false) {
    throw contentStateInvalid('Passing quality report does not require a guided rewrite');
  }
  const parsedContent = ContentDocumentSchema.safeParse(row.content);
  if (!parsedContent.success || parsedContent.data.platform_code !== platformCode) {
    throw contentStateInvalid('Quality report content does not match the target platform');
  }
  const source: QualityRewriteSource = {
    content: parsedContent.data,
    report: row,
  };
  const issues = qualityRewriteDiagnostics(source.report);
  if (issues.length === 0) {
    throw contentStateInvalid('Quality report has no actionable rewrite diagnostics');
  }
  return {
    eventData: {
      candidate: {
        master_content: { ...source.content, platform_code: 'master' },
        variants: [source.content],
      },
      content_version_id: source.report.contentVersionId,
      issues,
      quality_report_id: source.report.id,
    } as Record<string, JsonValue>,
  };
}

function qualityRewriteDiagnostics(report: QualityReportRow): readonly string[] {
  const diagnostics = (report.issuesJson.issues ?? [])
    .filter(isRecord)
    .map((issue) =>
      [
        `质量问题 ${readString(issue['severity'])} ${readString(issue['rule_id'])}`.trim(),
        `位置：${readString(issue['location']) || '未指定'}`,
        `问题：${readString(issue['message'])}`,
        readString(issue['suggestion']) ? `修改建议：${readString(issue['suggestion'])}` : '',
      ]
        .filter((part) => part.length > 0 && part !== '问题：')
        .join('；'),
    )
    .filter((issue) => issue.length > 0);
  const gate = report.automationGateJson;
  const blockingRules = Array.isArray(gate?.['blocking_rules'])
    ? gate['blocking_rules'].filter((value): value is string => typeof value === 'string')
    : [];
  for (const rule of blockingRules) {
    const metric = rule.startsWith('gate.') ? rule.slice('gate.'.length) : null;
    const current = metric ? gate?.[metric] : undefined;
    diagnostics.push(
      `质量门禁 ${rule} 未通过${typeof current === 'number' ? `，当前值为 ${current}` : ''}；必须针对该门禁和本报告问题修复，不得虚构事实或降低门槛。`,
    );
  }
  if (diagnostics.length === 0 && report.decision !== 'pass') {
    diagnostics.push(`质量报告结论为 ${report.decision}；必须修复报告结论后再提交质检。`);
  }
  return Object.freeze(diagnostics.slice(0, 50).map((diagnostic) => diagnostic.slice(0, 4_000)));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function requireContentVersion(client: SqlClient, tenantId: string, id: string) {
  const rows = await client<{ contentHash: string; id: string }[]>`
    SELECT id, content_hash AS "contentHash" FROM content_versions
    WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw contentNotFound();
  return row;
}

async function insertAudit(
  client: TransactionSql,
  tenantId: string,
  userId: string,
  action: string,
  resourceType: string,
  resourceId: string,
  before: unknown,
  after: unknown,
  reason: string | null,
  audit: ContentApiAudit,
) {
  const afterDocument = reason === null ? after : { resource: after, reason };
  await client`
    INSERT INTO audit_events (
      tenant_id, actor_id, action, resource_type, resource_id,
      before_json, after_json, ip, request_id
    ) VALUES (
      ${tenantId}::uuid, ${userId}::uuid, ${action}, ${resourceType}, ${resourceId}::uuid,
      ${JSON.stringify(before)}::text::jsonb, ${JSON.stringify(afterDocument)}::text::jsonb,
      ${audit.ip ?? null}, ${audit.requestId}
    )
  `;
}

function packageView(value: ContentPackageView): JsonValue {
  return snake({
    ...value,
    createdAt: isoDate(value.createdAt),
    updatedAt: isoDate(value.updatedAt),
  });
}

function packageListItemView(
  value: ContentPackageListRow,
  variants: readonly ContentVariantView[],
): JsonValue {
  return snake({
    ...value,
    createdAt: isoDate(value.createdAt),
    updatedAt: isoDate(value.updatedAt),
    variants: variants.map((variant) => ({
      ...variant,
      qualityScore: variant.qualityScore === null ? null : Number(variant.qualityScore),
    })),
  });
}

function variantView(value: ContentVariantView): JsonValue {
  return snake({
    ...value,
    qualityScore: value.qualityScore === null ? null : Number(value.qualityScore),
  });
}

function versionView(value: unknown): JsonValue {
  return snake(value);
}

function runView(value: ContentGenerationRunView): JsonValue {
  return snake(value);
}

function qualityReportView(value: QualityReportRow): JsonValue {
  const geoScores = Object.fromEntries(
    Object.entries(value.geoScoresJson).filter(([key]) => key !== 'schema_version'),
  );
  return {
    automation_gate: (value.automationGateJson ?? null) as JsonValue,
    checker_version: value.checkerVersion,
    content_version_id: value.contentVersionId,
    created_at: isoDate(value.createdAt),
    decision: value.decision,
    generation_run_id: value.generationRunId,
    geo_scores: geoScores as JsonValue,
    id: value.id,
    issues: (value.issuesJson.issues ?? []) as JsonValue,
    score: Number(value.score),
    tenant_id: value.tenantId,
    variant_id: value.variantId,
  };
}

function snake(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(snake);
  if (typeof value !== 'object') return value as JsonValue;
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'deletedAt' || item === undefined) continue;
    output[key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)] =
      serializeKnownDate(key, item) ?? snake(item);
  }
  return output;
}

const DATE_FIELDS = new Set([
  'createdAt',
  'dueAt',
  'expiresAt',
  'finishedAt',
  'publishedAt',
  'scheduledAt',
  'startedAt',
  'updatedAt',
]);

function serializeKnownDate(key: string, value: unknown): string | null {
  if (!DATE_FIELDS.has(key) || value === null || value === undefined) return null;
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function encodeCursor(cursor: PackageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): PackageCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (
      Object.keys(decoded).length !== 2 ||
      typeof decoded['id'] !== 'string' ||
      typeof decoded['updatedAt'] !== 'string' ||
      !Number.isFinite(new Date(decoded['updatedAt']).getTime())
    ) {
      throw new Error('invalid cursor');
    }
    return { id: decoded['id'], updatedAt: decoded['updatedAt'] };
  } catch {
    throw contentValidationInvalid('Content Package cursor is invalid');
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function qualityEvaluationInputHash(contentHash: string, runtime: GenerationRuntime): string {
  return sha256(
    qualityEvaluationFingerprintSource({
      contentHash,
      modelKey: runtime.modelKey,
      promptVersionId: runtime.promptVersionId,
      skillVersion: runtime.skillVersion,
    }),
  );
}
