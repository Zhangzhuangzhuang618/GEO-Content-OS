import type {
  ContentDocument as ApiContentDocument,
  ContentPackageQuery,
  ContentVariantStatus,
  CreateContentPackageRequest,
  DomainEventEnvelope,
  GenerateContentRequest,
  PlatformCode,
  RegenerateVariantRequest,
  ReopenVariantsRequest,
} from '@geo-content-os/contracts';
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { TransactionSql } from 'postgres';

import type { JsonValue } from '../../../common/idempotency/index.js';
import type { ContentDocument as DatabaseContentDocument } from '../../../database/schema/index.js';
import { GenerationRequestService } from '../../ai/orchestrator/index.js';
import { IdentityAuthDatabase } from '../../identity/auth/auth.database.js';
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

interface QualityReportRow {
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
    const rows = await this.database.client<ContentPackageView[]>`
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
        package.deleted_at AS "deletedAt"
      FROM content_packages AS package
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
    return {
      items: page.map(packageView),
      nextCursor:
        hasMore && tail
          ? encodeCursor({ id: tail.id, updatedAt: tail.updatedAt.toISOString() })
          : null,
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
    if (!['generated', 'quality_failed', 'quality_passed'].includes(variant.status)) {
      throw contentStateInvalid('Variant state does not permit a quality check');
    }
    await assertNoActiveVariantRun(transaction, tenantId, variantId);
    const runtime = readQualityRuntime();
    const current = await requireContentVersion(
      transaction,
      tenantId,
      variant.currentContentVersionId,
    );
    if (current.contentHash !== expectedContentHash) throw contentVersionConflict();
    const run = await insertGenerationRun(transaction, {
      inputHash: current.contentHash,
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
    if (!variant.isRequired || !canRegenerateContentVariant(variant.status)) {
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
    const inputHash = sha256(
      canonicalJson({ locks, runtime, variant_id: variantId, writer_input: writerInput }),
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
      UPDATE content_variants SET status = 'generating', version = version + 1
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
          package_id: variant.packageId,
          project_id: scope.projectId,
          prompt_version_id: runtime.promptVersionId,
          request_id: audit.requestId,
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
      { generation_run_id: run.id },
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
    const report = await selectLatestQualityReport(client, scope, variantId);
    return {
      citations: citations.map(snake),
      current_content: current ? versionView(current) : null,
      locks: locks.map(snake),
      quality_report: report ? qualityReportView(report) : null,
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
  const citations = await client<{ chunkId: string; quoteText: string; sourceId: string }[]>`
    SELECT
      chunk.id AS "chunkId",
      chunk.text AS "quoteText",
      source.id AS "sourceId"
    FROM content_packages AS package
    JOIN brief_sources AS link
      ON link.brief_id = package.brief_id
      AND link.tenant_id = package.tenant_id
    JOIN source_documents AS source
      ON source.id = link.source_document_id
      AND source.tenant_id = link.tenant_id
    JOIN source_chunks AS chunk
      ON chunk.source_document_id = source.id
      AND chunk.tenant_id = source.tenant_id
    WHERE package.id = ${packageId}::uuid
      AND package.tenant_id = ${scope.tenantId}::uuid
      AND package.workspace_id = ${scope.workspaceId}::uuid
      AND package.project_id = ${scope.projectId}::uuid
      AND source.status = 'active'
      AND source.deleted_at IS NULL
      AND source.trust_level IN ('normal', 'verified')
      AND (source.effective_from IS NULL OR source.effective_from <= current_date)
      AND (source.effective_to IS NULL OR source.effective_to >= current_date)
      AND chunk.status = 'active'
    ORDER BY link.required DESC, source.id, chunk.chunk_no, chunk.id
    LIMIT 100
  `;
  const rules = readPlatformRules(platformCodes);
  const locked = await loadLockedBlocks(client, scope.tenantId, null, lockedBlockKeys, packageId);
  return {
    brief: {
      audience: brief.audience,
      brief_id: brief.briefId,
      constraints: brief.constraints,
      objective: brief.objective,
      platform_codes: platformCodes,
      title: brief.title,
    },
    citations: citations.map((citation) => ({
      chunk_id: citation.chunkId,
      citation_id: citation.chunkId,
      quote_text: citation.quoteText,
      source_id: citation.sourceId,
    })),
    generation_mode: brief.generationMode,
    locked_blocks: locked,
    platform_rules_by_code: rules,
    strategy: { brand_profile_id: brand.id, profile: brand.profile, version: brand.version },
  };
}

function readPlatformRules(platformCodes: readonly PlatformCode[]): Record<string, JsonValue> {
  const raw = process.env['CONTENT_PLATFORM_RULES_JSON'];
  if (!raw) throw contentStateInvalid('CONTENT_PLATFORM_RULES_JSON is not configured');
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

async function selectLatestQualityReport(
  client: SqlClient,
  scope: ContentScope,
  variantId: string,
) {
  const rows = await client<QualityReportRow[]>`
    SELECT report.id, report.tenant_id AS "tenantId", report.variant_id AS "variantId",
      report.content_version_id AS "contentVersionId", report.generation_run_id AS "generationRunId",
      report.checker_version AS "checkerVersion", report.score::text AS score, report.decision,
      report.issues_json AS "issuesJson", report.geo_scores_json AS "geoScoresJson",
      report.created_at AS "createdAt"
    FROM quality_reports AS report
    JOIN content_variants AS variant ON variant.id = report.variant_id AND variant.tenant_id = report.tenant_id
    JOIN content_packages AS package ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
    WHERE report.tenant_id = ${scope.tenantId}::uuid AND report.variant_id = ${variantId}::uuid
      AND report.content_version_id = variant.current_content_version_id
      AND package.workspace_id = ${scope.workspaceId}::uuid AND package.project_id = ${scope.projectId}::uuid
      AND has_project_scope_access(package.tenant_id, package.workspace_id, package.project_id, ${scope.userId}::uuid)
    ORDER BY report.created_at DESC, report.id DESC LIMIT 1
  `;
  return rows[0];
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
  return snake(value);
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
    output[key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)] = snake(item);
  }
  return output;
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
