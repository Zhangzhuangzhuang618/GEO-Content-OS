import type {
  ContentPackageStatus,
  ContentVariantStatus,
  CreatePublishJobRequest,
  PlatformCode,
  PublishJobView,
  ResolveUnknownPublishRequest,
  RetryPublishRequest,
} from '@geo-content-os/contracts';
import {
  assertContentVariantTransition,
  resolvePublishCancellation,
} from '@geo-content-os/contracts';
import type { TransactionSql } from 'postgres';

import { resolveDatabaseClient, type DatabaseClientSource } from '../../../database/index.js';
import { RequiredAuditWriter } from '../../audit/index.js';
import { PackageStatusProjector } from '../../content/status/index.js';
import { OutboxWriter } from '../../outbox/index.js';
import { assessUnknownPublishResolution } from './publish-job-unknown-resolution.js';
import { PublishJobError } from './publish-job.errors.js';
import type { PublishJobScope } from './publish-job.types.js';

interface PublishTarget {
  readonly accountCapabilities: Readonly<Record<string, unknown>>;
  readonly accountDeletedAt: Date | null;
  readonly accountId: string;
  readonly accountPublishMode: 'api' | 'export' | 'manual';
  readonly accountStatus: 'active' | 'reauth' | 'disabled';
  readonly accountTokenExpiresAt: Date | null;
  readonly contentHash: string;
  readonly contentVersionId: string;
  readonly isRequired: boolean;
  readonly packageId: string;
  readonly packageStatus: ContentPackageStatus;
  readonly packageVersion: number;
  readonly platformCode: PlatformCode;
  readonly variantId: string;
  readonly variantStatus: ContentVariantStatus;
  readonly variantVersion: number;
}

interface JobRow {
  readonly accountId: string;
  readonly accountCapabilities: Readonly<Record<string, unknown>>;
  readonly accountDeletedAt: Date | null;
  readonly accountPublishMode: 'api' | 'export' | 'manual';
  readonly accountStatus: 'active' | 'reauth' | 'disabled';
  readonly accountTokenExpiresAt: Date | null;
  readonly attemptCount: number;
  readonly contentVersionId: string;
  readonly createdAt: Date | string;
  readonly createdBy: string;
  readonly externalPostId: string | null;
  readonly externalUrl: string | null;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly isRequired: boolean;
  readonly lastError: Readonly<Record<string, unknown>> | null;
  readonly origin: PublishJobView['origin'];
  readonly packageId: string;
  readonly packageStatus: ContentPackageStatus;
  readonly packageVersion: number;
  readonly payloadHash: string;
  readonly publishedAt: Date | string | null;
  readonly platformCode: PlatformCode;
  readonly scheduledAt: Date | string;
  readonly status: PublishJobView['status'];
  readonly tenantId: string;
  readonly updatedAt: Date | string;
  readonly variantCurrentContentVersionId: string | null;
  readonly variantId: string;
  readonly variantStatus: ContentVariantStatus;
  readonly variantVersion: number;
  readonly version: number;
}

interface ProjectionRow {
  readonly isRequired: boolean;
  readonly status: ContentVariantStatus;
}

interface LatestAttemptRow {
  readonly attemptNo: number;
  readonly errorCode: string | null;
  readonly status: 'failed' | 'running' | 'succeeded' | 'unknown';
}

interface ResolvedExternalState {
  readonly attemptNo: number;
  readonly automationStatus: 'manual_required' | 'publish_failed';
}

interface BrowserPublicationRow {
  readonly externalPostId: string | null;
  readonly id: string;
  readonly status: string;
}

type AutomatedOrigin = Exclude<PublishJobView['origin'], 'manual'>;
type BrowserPlatformAutomatedOrigin = Extract<
  AutomatedOrigin,
  'lieju_automation' | 'sohu_automation'
>;

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/u;

export class PublishJobService {
  private readonly projector = new PackageStatusProjector();
  private readonly audit: RequiredAuditWriter;
  private readonly databaseSource: DatabaseClientSource;
  private readonly outbox: OutboxWriter;

  public constructor(
    database: DatabaseClientSource,
    outbox?: OutboxWriter,
    audit: RequiredAuditWriter = new RequiredAuditWriter(),
  ) {
    this.databaseSource = database;
    this.outbox = outbox ?? new OutboxWriter(resolveDatabaseClient(database));
    this.audit = audit;
  }

  private get database() {
    return resolveDatabaseClient(this.databaseSource);
  }

  public create(
    scope: PublishJobScope,
    input: CreatePublishJobRequest,
    idempotencyKey: string,
  ): Promise<PublishJobView> {
    const scheduledAt = parseDate(input.scheduled_at);
    assertIdempotencyKey(idempotencyKey);
    return this.database.begin((transaction) =>
      this.createInTransaction(transaction, scope, input, idempotencyKey, scheduledAt),
    );
  }

  public async createInTransaction(
    transaction: TransactionSql,
    scope: PublishJobScope,
    input: CreatePublishJobRequest,
    idempotencyKey: string,
    scheduledAt = parseDate(input.scheduled_at),
  ): Promise<PublishJobView> {
    assertIdempotencyKey(idempotencyKey);
    const target = await loadPublishTarget(transaction, scope, input);
    assertSchedulable(target);
    const scheduledAtIso = scheduledAt.toISOString();
    const rows = await transaction<JobRow[]>`
        INSERT INTO publish_jobs (
          tenant_id, variant_id, content_version_id, account_id, scheduled_at,
          idempotency_key, payload_hash, status, created_by
        ) VALUES (
          ${scope.tenantId}::uuid, ${target.variantId}::uuid,
          ${target.contentVersionId}::uuid, ${target.accountId}::uuid,
          ${scheduledAtIso}::timestamptz,
          ${idempotencyKey}, ${target.contentHash}, 'scheduled', ${scope.userId}::uuid
        )
        RETURNING
          id, tenant_id AS "tenantId", variant_id AS "variantId",
          content_version_id AS "contentVersionId", account_id AS "accountId",
          scheduled_at AS "scheduledAt", idempotency_key AS "idempotencyKey",
          payload_hash AS "payloadHash", status, attempt_count AS "attemptCount",
          external_post_id AS "externalPostId", external_url AS "externalUrl",
          last_error_json AS "lastError", origin, published_at AS "publishedAt",
          created_by AS "createdBy", version,
          created_at AS "createdAt", updated_at AS "updatedAt"
      `;
    const job = requireInsertedJob(rows, target);
    await updateVariant(
      transaction,
      scope.tenantId,
      target.variantId,
      target.variantVersion,
      'approved',
      'scheduled',
    );
    await projectPackage(
      transaction,
      this.projector,
      scope.tenantId,
      target.packageId,
      target.packageStatus,
      target.packageVersion,
    );
    await enqueueExecution(transaction, this.outbox, scope, job, scheduledAt);
    await this.audit.record(transaction, {
      action: 'publish_job.scheduled',
      actorId: scope.userId,
      after: safeJob(job),
      before: null,
      ip: scope.ip ?? null,
      requestId: scope.requestId,
      resourceId: job.id,
      resourceType: 'publish_job',
      tenantId: scope.tenantId,
    });
    return mapJob(job);
  }

  public cancel(
    scope: PublishJobScope,
    jobId: string,
    expectedVersion: number,
    reason: string,
  ): Promise<PublishJobView> {
    assertVersion(expectedVersion);
    const normalizedReason = normalizeReason(reason);
    return this.database.begin(async (transaction) => {
      const before = await loadJob(transaction, scope, jobId);
      if (before.version !== expectedVersion) throw versionConflict();
      if (before.status !== 'scheduled' && before.status !== 'publishing') {
        throw stateInvalid('Publish job cannot be cancelled from its current state');
      }
      if (before.variantStatus !== before.status) {
        throw stateInvalid('Publish job and content variant states are inconsistent');
      }
      const resolution = resolvePublishCancellation(before.status === 'publishing');
      const rows = await transaction<JobRow[]>`
        UPDATE publish_jobs SET status=${resolution.publishJobStatus}, version=version+1
        WHERE id=${before.id}::uuid AND tenant_id=${scope.tenantId}::uuid
          AND version=${expectedVersion}
        RETURNING
          id, tenant_id AS "tenantId", variant_id AS "variantId",
          content_version_id AS "contentVersionId", account_id AS "accountId",
          scheduled_at AS "scheduledAt", idempotency_key AS "idempotencyKey",
          payload_hash AS "payloadHash", status, attempt_count AS "attemptCount",
          external_post_id AS "externalPostId", external_url AS "externalUrl",
          last_error_json AS "lastError", origin, published_at AS "publishedAt",
          created_by AS "createdBy", version,
          created_at AS "createdAt", updated_at AS "updatedAt"
      `;
      const after = requireChangedJob(rows, before);
      if (resolution.variantStatus === 'approved') {
        const restoredStatus = isAutomatedOrigin(before.origin) ? 'quality_passed' : 'approved';
        const cause = isAutomatedOrigin(before.origin)
          ? automationTransitionCause(before.origin)
          : before.variantStatus === 'publishing'
            ? 'publish_cancel_before_call'
            : 'normal';
        assertContentVariantTransition({
          cause,
          from: before.variantStatus,
          to: restoredStatus,
        });
        await updateVariant(
          transaction,
          scope.tenantId,
          before.variantId,
          before.variantVersion,
          before.variantStatus,
          restoredStatus,
        );
        if (isAutomatedOrigin(before.origin)) {
          await disableAutomationRun(
            transaction,
            scope.tenantId,
            before.id,
            before.origin,
            normalizedReason,
          );
        }
        await projectPackage(
          transaction,
          this.projector,
          scope.tenantId,
          before.packageId,
          before.packageStatus,
          before.packageVersion,
        );
      }
      await this.audit.record(transaction, {
        action:
          resolution.publishJobStatus === 'cancelled'
            ? 'publish_job.cancelled'
            : 'publish_job.cancel_requested',
        actorId: scope.userId,
        after: { ...safeJob(after), reason: normalizedReason },
        before: safeJob(before),
        ip: scope.ip ?? null,
        requestId: scope.requestId,
        resourceId: after.id,
        resourceType: 'publish_job',
        tenantId: scope.tenantId,
      });
      return mapJob(after);
    });
  }

  public retry(
    scope: PublishJobScope,
    jobId: string,
    expectedVersion: number,
    input: RetryPublishRequest,
  ): Promise<PublishJobView> {
    assertVersion(expectedVersion);
    const scheduledAt = input.scheduled_at ? parseDate(input.scheduled_at) : new Date();
    return this.database.begin((transaction) =>
      this.retryInTransaction(transaction, scope, jobId, expectedVersion, input, scheduledAt),
    );
  }

  public resolveUnknown(
    scope: PublishJobScope,
    jobId: string,
    expectedVersion: number,
    input: ResolveUnknownPublishRequest,
  ): Promise<PublishJobView> {
    assertVersion(expectedVersion);
    return this.database.begin((transaction) =>
      this.resolveUnknownInTransaction(transaction, scope, jobId, expectedVersion, input),
    );
  }

  public requestBaijiahaoReconciliation(
    scope: PublishJobScope,
    jobId: string,
    expectedVersion: number,
  ): Promise<PublishJobView> {
    assertVersion(expectedVersion);
    return this.database.begin((transaction) =>
      this.requestBaijiahaoReconciliationInTransaction(transaction, scope, jobId, expectedVersion),
    );
  }

  public async requestBaijiahaoReconciliationInTransaction(
    transaction: TransactionSql,
    scope: PublishJobScope,
    jobId: string,
    expectedVersion: number,
  ): Promise<PublishJobView> {
    assertVersion(expectedVersion);
    const before = await loadJob(transaction, scope, jobId);
    if (before.version !== expectedVersion) throw versionConflict();
    if (
      !isBrowserPlatform(before.platformCode) ||
      before.accountPublishMode !== 'api' ||
      before.status !== 'publishing' ||
      before.variantStatus !== 'publishing' ||
      !before.externalPostId
    ) {
      throw stateInvalid('Publish job is not eligible for browser publication reconciliation');
    }
    if (before.variantCurrentContentVersionId !== before.contentVersionId) {
      throw stateInvalid('The publish job no longer points to the current content version');
    }
    assertAccountReady(before);
    const publications = await selectBrowserPublications(
      transaction,
      scope.tenantId,
      before.id,
      before.platformCode,
    );
    const publication = publications[0];
    if (
      publications.length !== 1 ||
      publication?.externalPostId !== before.externalPostId ||
      (publication.status !== 'published' && publication.status !== 'failed')
    ) {
      throw stateInvalid('The browser publisher has not recorded a terminal publication state');
    }
    const rows = await transaction<JobRow[]>`
      UPDATE publish_jobs SET version=version+1
      WHERE id=${before.id}::uuid AND tenant_id=${scope.tenantId}::uuid
        AND status='publishing' AND version=${expectedVersion}
      RETURNING
        id,tenant_id AS "tenantId",variant_id AS "variantId",
        content_version_id AS "contentVersionId",account_id AS "accountId",
        scheduled_at AS "scheduledAt",idempotency_key AS "idempotencyKey",
        payload_hash AS "payloadHash",status,attempt_count AS "attemptCount",
        external_post_id AS "externalPostId",external_url AS "externalUrl",
        last_error_json AS "lastError",origin,published_at AS "publishedAt",
        created_by AS "createdBy",version,created_at AS "createdAt",updated_at AS "updatedAt"
    `;
    const after = requireChangedJob(rows, before);
    await enqueueBrowserReconciliation(transaction, this.outbox, scope, after, before.platformCode);
    await this.audit.record(transaction, {
      action: 'publish_job.reconciliation_requested',
      actorId: scope.userId,
      after: {
        ...safeJob(after),
        reconciliation: {
          browser_status: publication.status,
          external_post_id: before.externalPostId,
        },
      },
      before: safeJob(before),
      ip: scope.ip ?? null,
      requestId: scope.requestId,
      resourceId: after.id,
      resourceType: 'publish_job',
      tenantId: scope.tenantId,
    });
    return mapJob(after);
  }

  public async resolveUnknownInTransaction(
    transaction: TransactionSql,
    scope: PublishJobScope,
    jobId: string,
    expectedVersion: number,
    input: ResolveUnknownPublishRequest,
  ): Promise<PublishJobView> {
    assertVersion(expectedVersion);
    const before = await loadJob(transaction, scope, jobId);
    if (before.version !== expectedVersion) throw versionConflict();
    if (!isBrowserPlatform(before.platformCode)) {
      throw stateInvalid('Only browser-published unknown publications can be resolved here');
    }
    const latestAttempt = await loadLatestAttempt(transaction, scope.tenantId, before.id);
    if (!latestAttempt) {
      throw stateInvalid('Latest publish attempt does not require manual resolution');
    }
    const assessment = assessUnknownPublishResolution({
      contentVersionId: before.contentVersionId,
      jobStatus: before.status,
      latestAttempt,
      liejuOfficial: isLiejuOfficialJob(before),
      platformCode: before.platformCode,
      variantCurrentContentVersionId: before.variantCurrentContentVersionId,
      variantStatus: before.variantStatus,
    });
    if (!assessment) {
      throw stateInvalid('Latest publish attempt does not require manual resolution');
    }
    if (assessment.blockedReason === 'content_state_changed') {
      throw stateInvalid('Publish job is not waiting for unknown-state resolution');
    }
    if (assessment.blockedReason === 'content_version_changed') {
      throw stateInvalid('The publish job no longer points to the current content version');
    }
    const processingOfficial = assessment.processingOfficial;
    const publications = isLiejuOfficialJob(before)
      ? await selectLiejuOfficialPublications(transaction, scope.tenantId, before.id)
      : await selectBrowserPublications(
          transaction,
          scope.tenantId,
          before.id,
          before.platformCode,
        );
    const publication = publications[0];

    if (input.resolution === 'not_published_closed') {
      if (before.status !== 'failed' || before.variantStatus !== 'publish_failed') {
        throw stateInvalid('Only a failed publish job can be closed as not published');
      }
      const attemptLimit = isAutomatedOrigin(before.origin) ? 3 : 20;
      if (before.attemptCount < attemptLimit) {
        throw stateInvalid('Publish job can still be retried');
      }
      if (before.externalPostId || publication?.externalPostId) {
        throw stateInvalid('A remote publication is already linked to this publish job');
      }
      if (publication) {
        const closed = isLiejuOfficialJob(before)
          ? await resetLiejuOfficialPublication(transaction, scope.tenantId, publication.id)
          : await closeBrowserPublicationNotPublished(
              transaction,
              scope.tenantId,
              publication.id,
              before.platformCode,
            );
        if (closed.length !== 1) throw stateInvalid('Browser publication state changed');
      }
      const rows = await transaction<JobRow[]>`
        UPDATE publish_jobs SET status='cancelled',version=version+1
        WHERE id=${before.id}::uuid AND tenant_id=${scope.tenantId}::uuid
          AND version=${expectedVersion} AND status='failed'
        RETURNING
          id,tenant_id AS "tenantId",variant_id AS "variantId",
          content_version_id AS "contentVersionId",account_id AS "accountId",
          scheduled_at AS "scheduledAt",idempotency_key AS "idempotencyKey",
          payload_hash AS "payloadHash",status,attempt_count AS "attemptCount",
          external_post_id AS "externalPostId",external_url AS "externalUrl",
          last_error_json AS "lastError",origin,published_at AS "publishedAt",
          created_by AS "createdBy",version,created_at AS "createdAt",updated_at AS "updatedAt"
      `;
      const after = requireChangedJob(rows, before);
      const restoredStatus = isAutomatedOrigin(before.origin) ? 'quality_passed' : 'approved';
      assertContentVariantTransition({
        cause: isAutomatedOrigin(before.origin)
          ? automationTransitionCause(before.origin)
          : 'normal',
        from: 'publish_failed',
        to: restoredStatus,
      });
      await updateVariant(
        transaction,
        scope.tenantId,
        before.variantId,
        before.variantVersion,
        'publish_failed',
        restoredStatus,
      );
      if (isAutomatedOrigin(before.origin)) {
        await disableAutomationRun(
          transaction,
          scope.tenantId,
          before.id,
          before.origin,
          `人工核实${browserPlatformLabel(before.platformCode)}后台未创建内容，发布任务结束。`,
        );
      }
      await projectPackage(
        transaction,
        this.projector,
        scope.tenantId,
        before.packageId,
        before.packageStatus,
        before.packageVersion,
      );
      await supersedePendingExecution(transaction, scope.tenantId, before.id);
      await this.audit.record(transaction, {
        action: 'publish_job.unknown_resolved_not_published_closed',
        actorId: scope.userId,
        after: {
          ...safeJob(after),
          unknown_resolution: {
            latest_attempt_no: latestAttempt.attemptNo,
            resolution: 'not_published_closed',
          },
        },
        before: safeJob(before),
        ip: scope.ip ?? null,
        requestId: scope.requestId,
        resourceId: after.id,
        resourceType: 'publish_job',
        tenantId: scope.tenantId,
      });
      return mapJob(after);
    }

    if (input.resolution === 'not_published') {
      if (publication?.externalPostId) {
        throw stateInvalid('A remote publication is already linked to this publish job');
      }
      if (publication) {
        const reset = isLiejuOfficialJob(before)
          ? await resetLiejuOfficialPublication(transaction, scope.tenantId, publication.id)
          : await resetBrowserPublication(
              transaction,
              scope.tenantId,
              publication.id,
              before.platformCode,
            );
        if (reset.length !== 1) throw stateInvalid('Browser publication state changed');
      }
      const retryVersion = processingOfficial
        ? await markProcessingJobNotPublished(transaction, scope.tenantId, before)
        : expectedVersion;
      return this.retryInTransaction(transaction, scope, jobId, retryVersion, {}, new Date(), {
        attemptNo: latestAttempt.attemptNo,
        automationStatus:
          latestAttempt.status === 'unknown' || latestAttempt.errorCode === 'MANUAL_REQUIRED'
            ? 'manual_required'
            : 'publish_failed',
      });
    }

    if (
      publication?.externalPostId &&
      input.external_post_id &&
      publication.externalPostId !== input.external_post_id
    ) {
      throw stateInvalid('Confirmed remote publication does not match the linked publication');
    }
    const externalPostId = input.external_post_id ?? publication?.externalPostId ?? null;
    if (publication) {
      const linked = isLiejuOfficialJob(before)
        ? await confirmLiejuOfficialPublication(
            transaction,
            scope.tenantId,
            publication.id,
            externalPostId,
            input.external_url,
          )
        : await confirmBrowserPublication(
            transaction,
            scope.tenantId,
            publication.id,
            before.platformCode,
            externalPostId,
            input.external_url,
          );
      if (linked.length !== 1) throw stateInvalid('Browser publication state changed');
    }
    const publishedAt = new Date();
    const rows = await transaction<JobRow[]>`
      UPDATE publish_jobs SET
        status='published',external_post_id=${externalPostId},external_url=${input.external_url},
        published_at=${publishedAt.toISOString()}::timestamptz,last_error_json=NULL,version=version+1
      WHERE id=${before.id}::uuid AND tenant_id=${scope.tenantId}::uuid
        AND version=${expectedVersion} AND status IN ('failed','publishing')
      RETURNING
        id,tenant_id AS "tenantId",variant_id AS "variantId",
        content_version_id AS "contentVersionId",account_id AS "accountId",
        scheduled_at AS "scheduledAt",idempotency_key AS "idempotencyKey",
        payload_hash AS "payloadHash",status,attempt_count AS "attemptCount",
        external_post_id AS "externalPostId",external_url AS "externalUrl",
        last_error_json AS "lastError",origin,published_at AS "publishedAt",
        created_by AS "createdBy",version,created_at AS "createdAt",updated_at AS "updatedAt"
    `;
    const after = requireChangedJob(rows, before);
    if (before.variantStatus === 'publish_failed') {
      assertContentVariantTransition({ from: 'publish_failed', to: 'publishing' });
      await updateVariant(
        transaction,
        scope.tenantId,
        before.variantId,
        before.variantVersion,
        'publish_failed',
        'publishing',
      );
    }
    assertContentVariantTransition({ from: 'publishing', to: 'published' });
    await updateVariant(
      transaction,
      scope.tenantId,
      before.variantId,
      before.variantVersion + (before.variantStatus === 'publish_failed' ? 1 : 0),
      'publishing',
      'published',
    );
    if (before.origin === 'baijiahao_automation') {
      await confirmBaijiahaoAutomationPublished(
        transaction,
        scope.tenantId,
        before.id,
        publishedAt,
      );
    } else if (isBrowserPlatformAutomatedOrigin(before.origin)) {
      await confirmBrowserPlatformAutomationPublished(
        transaction,
        scope.tenantId,
        before.id,
        publishedAt,
      );
    }
    await projectPackage(
      transaction,
      this.projector,
      scope.tenantId,
      before.packageId,
      before.packageStatus,
      before.packageVersion,
    );
    await supersedePendingExecution(transaction, scope.tenantId, before.id);
    await this.audit.record(transaction, {
      action: 'publish_job.unknown_resolved_published',
      actorId: scope.userId,
      after: {
        ...safeJob(after),
        unknown_resolution: {
          external_post_id: externalPostId,
          external_url: input.external_url,
          latest_attempt_no: latestAttempt.attemptNo,
          resolution: 'published',
        },
      },
      before: safeJob(before),
      ip: scope.ip ?? null,
      requestId: scope.requestId,
      resourceId: after.id,
      resourceType: 'publish_job',
      tenantId: scope.tenantId,
    });
    return mapJob(after);
  }

  public async retryInTransaction(
    transaction: TransactionSql,
    scope: PublishJobScope,
    jobId: string,
    expectedVersion: number,
    input: RetryPublishRequest,
    scheduledAt = input.scheduled_at ? parseDate(input.scheduled_at) : new Date(),
    resolvedExternalState?: ResolvedExternalState,
  ): Promise<PublishJobView> {
    assertVersion(expectedVersion);
    const before = await loadJob(transaction, scope, jobId);
    if (before.version !== expectedVersion) throw versionConflict();
    if (!input.scheduled_at && before.status !== 'failed') {
      throw stateInvalid('A new schedule is required for this publish job');
    }
    if (before.status === 'scheduled' && before.variantStatus !== 'scheduled') {
      throw stateInvalid('Publish job and content variant states are inconsistent');
    }
    const restoredStatus = isAutomatedOrigin(before.origin) ? 'quality_passed' : 'approved';
    if (before.status === 'cancelled' && before.variantStatus !== restoredStatus) {
      throw stateInvalid('Cancelled publish job and content variant states are inconsistent');
    }
    if (before.status === 'failed' && before.variantStatus !== 'publish_failed') {
      throw stateInvalid('Failed publish job and content variant states are inconsistent');
    }
    if (
      before.status !== 'scheduled' &&
      before.status !== 'cancelled' &&
      before.status !== 'failed'
    ) {
      throw stateInvalid('Publish job cannot be rescheduled from its current state');
    }
    if (before.packageStatus === 'archived' || before.packageStatus === 'cancelled') {
      throw stateInvalid('Terminal content package cannot be retried');
    }
    const attemptLimit = isAutomatedOrigin(before.origin) ? 3 : 20;
    if (before.attemptCount >= attemptLimit) {
      throw stateInvalid('Publish job attempt limit was reached');
    }
    if (before.variantCurrentContentVersionId !== before.contentVersionId) {
      throw stateInvalid('The publish job no longer points to the current content version');
    }
    if (
      before.status !== 'scheduled' &&
      resolvedExternalState === undefined &&
      (await latestAttemptRequiresManualResolution(
        transaction,
        scope.tenantId,
        before.id,
        before.platformCode,
      ))
    ) {
      throw stateInvalid('External publish state requires manual resolution');
    }
    assertAccountReady(before);
    const scheduledAtIso = scheduledAt.toISOString();
    const rows = await transaction<JobRow[]>`
        UPDATE publish_jobs SET
          status='scheduled', scheduled_at=${scheduledAtIso}::timestamptz,
          last_error_json=NULL, version=version+1
        WHERE id=${before.id}::uuid AND tenant_id=${scope.tenantId}::uuid
          AND version=${expectedVersion} AND status=${before.status}
        RETURNING
          id, tenant_id AS "tenantId", variant_id AS "variantId",
          content_version_id AS "contentVersionId", account_id AS "accountId",
          scheduled_at AS "scheduledAt", idempotency_key AS "idempotencyKey",
          payload_hash AS "payloadHash", status, attempt_count AS "attemptCount",
          external_post_id AS "externalPostId", external_url AS "externalUrl",
          last_error_json AS "lastError", origin, published_at AS "publishedAt",
          created_by AS "createdBy", version,
          created_at AS "createdAt", updated_at AS "updatedAt"
      `;
    const after = requireChangedJob(rows, before);
    if (before.status !== 'scheduled') {
      const transitionCause = isAutomatedOrigin(before.origin)
        ? automationTransitionCause(before.origin)
        : 'normal';
      if (before.status === 'failed') {
        assertContentVariantTransition({
          cause: transitionCause,
          from: 'publish_failed',
          to: restoredStatus,
        });
        await updateVariant(
          transaction,
          scope.tenantId,
          before.variantId,
          before.variantVersion,
          'publish_failed',
          restoredStatus,
        );
      }
      assertContentVariantTransition({
        cause: transitionCause,
        from: restoredStatus,
        to: 'scheduled',
      });
      await updateVariant(
        transaction,
        scope.tenantId,
        before.variantId,
        before.status === 'failed' ? before.variantVersion + 1 : before.variantVersion,
        restoredStatus,
        'scheduled',
      );
      if (isAutomatedOrigin(before.origin)) {
        await restartAutomationRun(
          transaction,
          scope.tenantId,
          before.id,
          before.origin,
          before.status === 'failed'
            ? (resolvedExternalState?.automationStatus ?? 'publish_failed')
            : 'disabled',
        );
        await syncDailyBatchSchedule(
          transaction,
          scope.tenantId,
          before.id,
          before.origin,
          scheduledAtIso,
        );
      }
      await projectPackage(
        transaction,
        this.projector,
        scope.tenantId,
        before.packageId,
        before.packageStatus,
        before.packageVersion,
      );
    } else if (isAutomatedOrigin(before.origin)) {
      await syncDailyBatchSchedule(
        transaction,
        scope.tenantId,
        before.id,
        before.origin,
        scheduledAtIso,
      );
    }
    await supersedePendingExecution(transaction, scope.tenantId, before.id);
    await enqueueExecution(transaction, this.outbox, scope, after, scheduledAt);
    await this.audit.record(transaction, {
      action:
        resolvedExternalState === undefined
          ? before.status === 'failed'
            ? 'publish_job.retried'
            : 'publish_job.rescheduled'
          : 'publish_job.unknown_resolved_not_published',
      actorId: scope.userId,
      after:
        resolvedExternalState === undefined
          ? safeJob(after)
          : {
              ...safeJob(after),
              unknown_resolution: {
                latest_attempt_no: resolvedExternalState.attemptNo,
                resolution: 'not_published',
              },
            },
      before: safeJob(before),
      ip: scope.ip ?? null,
      requestId: scope.requestId,
      resourceId: after.id,
      resourceType: 'publish_job',
      tenantId: scope.tenantId,
    });
    return mapJob(after);
  }
}

async function loadPublishTarget(
  transaction: TransactionSql,
  scope: PublishJobScope,
  input: CreatePublishJobRequest,
): Promise<PublishTarget> {
  const rows = await transaction<PublishTarget[]>`
    SELECT
      variant.id AS "variantId", variant.status AS "variantStatus",
      variant.version AS "variantVersion", variant.is_required AS "isRequired",
      variant.platform_code AS "platformCode", package.id AS "packageId",
      package.status AS "packageStatus", package.version AS "packageVersion",
      content_version.id AS "contentVersionId", content_version.content_hash AS "contentHash",
      account.id AS "accountId", account.status AS "accountStatus",
      account.publish_mode AS "accountPublishMode",
      account.capabilities_json AS "accountCapabilities",
      account.deleted_at AS "accountDeletedAt",
      account.token_expires_at AS "accountTokenExpiresAt"
    FROM content_variants AS variant
    JOIN content_packages AS package
      ON package.id=variant.package_id AND package.tenant_id=variant.tenant_id
    JOIN content_versions AS content_version
      ON content_version.id=variant.current_content_version_id
      AND content_version.tenant_id=variant.tenant_id
      AND content_version.package_id=variant.package_id
      AND content_version.variant_id=variant.id
    JOIN platform_accounts AS account
      ON account.id=${input.account_id}::uuid AND account.tenant_id=variant.tenant_id
      AND account.workspace_id=package.workspace_id
      AND account.platform_code=variant.platform_code
    WHERE variant.id=${input.variant_id}::uuid AND variant.tenant_id=${scope.tenantId}::uuid
      AND account.deleted_at IS NULL
      AND has_project_scope_access(
        package.tenant_id, package.workspace_id, package.project_id, ${scope.userId}::uuid
      )
    FOR UPDATE OF variant, package, account
  `;
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

async function loadJob(
  transaction: TransactionSql,
  scope: PublishJobScope,
  jobId: string,
): Promise<JobRow> {
  const rows = await transaction<JobRow[]>`
    SELECT
      job.id, job.tenant_id AS "tenantId", job.variant_id AS "variantId",
      job.content_version_id AS "contentVersionId", job.account_id AS "accountId",
      job.scheduled_at AS "scheduledAt", job.idempotency_key AS "idempotencyKey",
      job.payload_hash AS "payloadHash", job.status,
      job.attempt_count AS "attemptCount", job.external_post_id AS "externalPostId",
      job.external_url AS "externalUrl", job.last_error_json AS "lastError", job.origin,
      job.published_at AS "publishedAt",
      job.created_by AS "createdBy", job.version, job.created_at AS "createdAt",
      job.updated_at AS "updatedAt", variant.status AS "variantStatus",
      variant.version AS "variantVersion", variant.is_required AS "isRequired",
      variant.platform_code AS "platformCode",
      variant.current_content_version_id AS "variantCurrentContentVersionId",
      package.id AS "packageId", package.status AS "packageStatus",
      package.version AS "packageVersion", account.status AS "accountStatus",
      account.publish_mode AS "accountPublishMode",
      account.capabilities_json AS "accountCapabilities",
      account.deleted_at AS "accountDeletedAt",
      account.token_expires_at AS "accountTokenExpiresAt"
    FROM publish_jobs AS job
    JOIN content_variants AS variant
      ON variant.id=job.variant_id AND variant.tenant_id=job.tenant_id
    JOIN content_packages AS package
      ON package.id=variant.package_id AND package.tenant_id=variant.tenant_id
    JOIN platform_accounts AS account
      ON account.id=job.account_id AND account.tenant_id=job.tenant_id
    WHERE job.id=${jobId}::uuid AND job.tenant_id=${scope.tenantId}::uuid
      AND has_project_scope_access(
        package.tenant_id, package.workspace_id, package.project_id, ${scope.userId}::uuid
      )
    FOR UPDATE OF job, variant, package, account
  `;
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

function assertSchedulable(target: PublishTarget): void {
  if (target.packageStatus === 'archived' || target.packageStatus === 'cancelled') {
    throw stateInvalid('Terminal content package cannot be scheduled');
  }
  if (target.variantStatus !== 'approved') {
    throw stateInvalid('Only an approved content variant can be scheduled');
  }
  assertContentVariantTransition({ from: target.variantStatus, to: 'scheduled' });
  assertAccountReady(target);
}

function assertAccountReady(account: {
  readonly accountCapabilities: Readonly<Record<string, unknown>>;
  readonly accountDeletedAt: Date | null;
  readonly accountPublishMode: 'api' | 'export' | 'manual';
  readonly accountStatus: 'active' | 'reauth' | 'disabled';
  readonly accountTokenExpiresAt: Date | null;
}): void {
  if (
    account.accountStatus === 'reauth' ||
    (account.accountTokenExpiresAt !== null && account.accountTokenExpiresAt <= new Date())
  ) {
    throw new PublishJobError(
      'PUBLISH_ACCOUNT_AUTH_EXPIRED',
      'Platform account authorization has expired',
    );
  }
  if (account.accountDeletedAt !== null || account.accountStatus !== 'active') {
    throw stateInvalid('Platform account is disabled');
  }
  const capability = account.accountPublishMode === 'api' ? 'publish' : 'export';
  if (account.accountPublishMode !== 'manual' && account.accountCapabilities[capability] !== true) {
    throw new PublishJobError(
      'PUBLISH_CAPABILITY_UNAVAILABLE',
      `Platform account does not support ${capability}`,
    );
  }
}

async function updateVariant(
  transaction: TransactionSql,
  tenantId: string,
  variantId: string,
  version: number,
  from: ContentVariantStatus,
  to: ContentVariantStatus,
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    UPDATE content_variants SET status=${to}, version=version+1
    WHERE id=${variantId}::uuid AND tenant_id=${tenantId}::uuid
      AND version=${version} AND status=${from}
    RETURNING id
  `;
  if (rows.length !== 1) throw versionConflict();
}

async function projectPackage(
  transaction: TransactionSql,
  projector: PackageStatusProjector,
  tenantId: string,
  packageId: string,
  currentStatus: ContentPackageStatus,
  expectedVersion: number,
): Promise<void> {
  const variants = await transaction<ProjectionRow[]>`
    SELECT status, is_required AS "isRequired"
    FROM content_variants
    WHERE package_id=${packageId}::uuid AND tenant_id=${tenantId}::uuid
    ORDER BY id
  `;
  const status = projector.project({ currentStatus, variants });
  const rows = await transaction<{ id: string }[]>`
    UPDATE content_packages SET status=${status}, version=version+1
    WHERE id=${packageId}::uuid AND tenant_id=${tenantId}::uuid AND version=${expectedVersion}
    RETURNING id
  `;
  if (rows.length !== 1) throw versionConflict();
}

async function enqueueExecution(
  transaction: TransactionSql,
  outbox: OutboxWriter,
  scope: PublishJobScope,
  job: Pick<JobRow, 'id' | 'version'>,
  scheduledAt: Date,
): Promise<void> {
  const scheduledAtIso = scheduledAt.toISOString();
  const event = await outbox.enqueue(
    {
      aggregateId: job.id,
      aggregateType: 'publish_job',
      data: {
        job_id: job.id,
        job_version: job.version,
        request_id: scope.requestId,
        scheduled_at: scheduledAtIso,
      },
      eventType: 'publishing.job.execution_requested.v1',
      tenantId: scope.tenantId,
    },
    transaction,
  );
  await transaction`
    UPDATE outbox_events SET next_attempt_at=GREATEST(${scheduledAtIso}::timestamptz,now())
    WHERE id=${event.event_id}::uuid AND tenant_id=${scope.tenantId}::uuid
  `;
}

async function enqueueBrowserReconciliation(
  transaction: TransactionSql,
  outbox: OutboxWriter,
  scope: PublishJobScope,
  job: Pick<JobRow, 'accountId' | 'id' | 'version'>,
  platformCode: 'baijiahao' | 'lieju' | 'sohu',
): Promise<void> {
  await outbox.enqueue(
    {
      aggregateId: job.id,
      aggregateType: 'publish_job',
      data: {
        account_id: job.accountId,
        external_post_id: null,
        job_id: job.id,
        job_version: job.version,
        reconcile_attempt: 1,
        request_id: scope.requestId,
      },
      eventType: `${platformCode}.publication.reconcile_requested.v1`,
      tenantId: scope.tenantId,
    },
    transaction,
  );
}

async function latestAttemptRequiresManualResolution(
  transaction: TransactionSql,
  tenantId: string,
  jobId: string,
  platformCode: PlatformCode,
): Promise<boolean> {
  const attempt = await loadLatestAttempt(transaction, tenantId, jobId);
  if (!attempt) return false;
  return (
    attempt.status === 'unknown' ||
    (['baijiahao', 'sohu', 'lieju'].includes(platformCode) &&
      attemptRequiresManualResolution(attempt))
  );
}

function selectBrowserPublications(
  transaction: TransactionSql,
  tenantId: string,
  jobId: string,
  platformCode: 'baijiahao' | 'lieju' | 'sohu',
): Promise<BrowserPublicationRow[]> {
  if (platformCode === 'sohu') {
    return transaction<BrowserPublicationRow[]>`
      SELECT id,external_post_id AS "externalPostId",status
      FROM sohu_browser_publications
      WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${jobId}::uuid
      FOR UPDATE
    `;
  }
  if (platformCode === 'lieju') {
    return transaction<BrowserPublicationRow[]>`
      SELECT id,external_post_id AS "externalPostId",status
      FROM lieju_browser_publications
      WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${jobId}::uuid
      FOR UPDATE
    `;
  }
  return transaction<BrowserPublicationRow[]>`
    SELECT id,external_post_id AS "externalPostId",status
    FROM baijiahao_browser_publications
    WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${jobId}::uuid
    FOR UPDATE
  `;
}

function isLiejuOfficialJob(job: Pick<JobRow, 'accountCapabilities' | 'platformCode'>): boolean {
  return (
    job.platformCode === 'lieju' && job.accountCapabilities['delivery_method'] === 'official_api'
  );
}

function selectLiejuOfficialPublications(
  transaction: TransactionSql,
  tenantId: string,
  jobId: string,
): Promise<BrowserPublicationRow[]> {
  return transaction<BrowserPublicationRow[]>`
    SELECT id,remote_reference AS "externalPostId",status
    FROM lieju_api_publications
    WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${jobId}::uuid
    FOR UPDATE
  `;
}

function resetLiejuOfficialPublication(
  transaction: TransactionSql,
  tenantId: string,
  publicationId: string,
): Promise<{ id: string }[]> {
  return transaction<{ id: string }[]>`
    UPDATE lieju_api_publications SET
      status='not_published',remote_reference=NULL,external_url=NULL,response_hash=NULL,
      submitted_at=NULL,last_error_json=NULL,version=version+1
    WHERE id=${publicationId}::uuid AND tenant_id=${tenantId}::uuid
      AND status IN ('reserved','processing','manual_required')
    RETURNING id
  `;
}

function confirmLiejuOfficialPublication(
  transaction: TransactionSql,
  tenantId: string,
  publicationId: string,
  externalPostId: string | null,
  externalUrl: string,
): Promise<{ id: string }[]> {
  return transaction<{ id: string }[]>`
    UPDATE lieju_api_publications SET
      status='published',remote_reference=${externalPostId},external_url=${externalUrl},
      submitted_at=COALESCE(submitted_at,now()),last_error_json=NULL,version=version+1
    WHERE id=${publicationId}::uuid AND tenant_id=${tenantId}::uuid
      AND status IN ('reserved','processing','manual_required')
    RETURNING id
  `;
}

async function markProcessingJobNotPublished(
  transaction: TransactionSql,
  tenantId: string,
  job: JobRow,
): Promise<number> {
  const rows = await transaction<{ version: number }[]>`
    UPDATE publish_jobs SET status='failed',version=version+1
    WHERE id=${job.id}::uuid AND tenant_id=${tenantId}::uuid
      AND version=${job.version} AND status='publishing'
    RETURNING version
  `;
  const version = rows[0]?.version;
  if (!version) throw stateInvalid('Publish job state changed');
  assertContentVariantTransition({ from: 'publishing', to: 'publish_failed' });
  await updateVariant(
    transaction,
    tenantId,
    job.variantId,
    job.variantVersion,
    'publishing',
    'publish_failed',
  );
  if (job.origin === 'lieju_automation') {
    await transaction`
      UPDATE browser_platform_automation_runs SET
        status='publish_failed',finished_at=now(),version=version+1
      WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${job.id}::uuid
        AND platform_code='lieju' AND status='processing'
    `;
    await transaction`
      UPDATE browser_platform_daily_batch_items SET status='publish_failed'
      WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${job.id}::uuid
        AND status='processing'
    `;
  }
  return version;
}

function resetBrowserPublication(
  transaction: TransactionSql,
  tenantId: string,
  publicationId: string,
  platformCode: 'baijiahao' | 'lieju' | 'sohu',
): Promise<{ id: string }[]> {
  const reason = `人工核实${browserPlatformLabel(platformCode)}后台未创建内容，允许使用原幂等键重试。`;
  if (platformCode === 'sohu') {
    return transaction<{ id: string }[]>`
      UPDATE sohu_browser_publications SET
        status='prepared',external_post_id=NULL,external_url=NULL,review_reason=${reason},
        submitted_at=NULL,last_reconciled_at=now(),version=version+1
      WHERE id=${publicationId}::uuid AND tenant_id=${tenantId}::uuid
        AND status IN ('submitting','unknown','processing','manual_required')
      RETURNING id
    `;
  }
  if (platformCode === 'lieju') {
    return transaction<{ id: string }[]>`
      UPDATE lieju_browser_publications SET
        status='prepared',external_post_id=NULL,external_url=NULL,review_reason=${reason},
        submitted_at=NULL,last_reconciled_at=now(),version=version+1
      WHERE id=${publicationId}::uuid AND tenant_id=${tenantId}::uuid
        AND status IN ('submitting','unknown','processing','manual_required')
      RETURNING id
    `;
  }
  return transaction<{ id: string }[]>`
    UPDATE baijiahao_browser_publications SET
      status='prepared',external_post_id=NULL,external_url=NULL,review_reason=${reason},
      submitted_at=NULL,last_reconciled_at=now(),version=version+1
    WHERE id=${publicationId}::uuid AND tenant_id=${tenantId}::uuid
      AND status IN ('submitting','unknown','processing','manual_required')
    RETURNING id
  `;
}

function closeBrowserPublicationNotPublished(
  transaction: TransactionSql,
  tenantId: string,
  publicationId: string,
  platformCode: 'baijiahao' | 'lieju' | 'sohu',
): Promise<{ id: string }[]> {
  const reason = `人工核实${browserPlatformLabel(platformCode)}后台未创建内容，发布任务结束。`;
  if (platformCode === 'sohu') {
    return transaction<{ id: string }[]>`
      UPDATE sohu_browser_publications SET
        status='failed',external_post_id=NULL,external_url=NULL,review_reason=${reason},
        last_reconciled_at=now(),version=version+1
      WHERE id=${publicationId}::uuid AND tenant_id=${tenantId}::uuid
        AND status IN ('submitting','unknown','processing','manual_required','failed')
      RETURNING id
    `;
  }
  if (platformCode === 'lieju') {
    return transaction<{ id: string }[]>`
      UPDATE lieju_browser_publications SET
        status='failed',external_post_id=NULL,external_url=NULL,review_reason=${reason},
        last_reconciled_at=now(),version=version+1
      WHERE id=${publicationId}::uuid AND tenant_id=${tenantId}::uuid
        AND status IN ('submitting','unknown','processing','manual_required','failed')
      RETURNING id
    `;
  }
  return transaction<{ id: string }[]>`
    UPDATE baijiahao_browser_publications SET
      status='failed',external_post_id=NULL,external_url=NULL,review_reason=${reason},
      last_reconciled_at=now(),version=version+1
    WHERE id=${publicationId}::uuid AND tenant_id=${tenantId}::uuid
      AND status IN ('submitting','unknown','processing','manual_required','failed')
    RETURNING id
  `;
}

function confirmBrowserPublication(
  transaction: TransactionSql,
  tenantId: string,
  publicationId: string,
  platformCode: 'baijiahao' | 'lieju' | 'sohu',
  externalPostId: string | null,
  externalUrl: string,
): Promise<{ id: string }[]> {
  const reason = `人工核实${browserPlatformLabel(platformCode)}内容已经发布。`;
  if (platformCode === 'sohu') {
    return transaction<{ id: string }[]>`
      UPDATE sohu_browser_publications SET
        status='published',external_post_id=${externalPostId},external_url=${externalUrl},
        review_reason=${reason},last_reconciled_at=now(),version=version+1
      WHERE id=${publicationId}::uuid AND tenant_id=${tenantId}::uuid
        AND status IN ('submitting','unknown','processing','manual_required')
      RETURNING id
    `;
  }
  if (platformCode === 'lieju') {
    return transaction<{ id: string }[]>`
      UPDATE lieju_browser_publications SET
        status='published',external_post_id=${externalPostId},external_url=${externalUrl},
        review_reason=${reason},last_reconciled_at=now(),version=version+1
      WHERE id=${publicationId}::uuid AND tenant_id=${tenantId}::uuid
        AND status IN ('submitting','unknown','processing','manual_required')
      RETURNING id
    `;
  }
  return transaction<{ id: string }[]>`
    UPDATE baijiahao_browser_publications SET
      status='published',external_post_id=${externalPostId},external_url=${externalUrl},
      review_reason=${reason},last_reconciled_at=now(),version=version+1
    WHERE id=${publicationId}::uuid AND tenant_id=${tenantId}::uuid
      AND status IN ('submitting','unknown','processing','manual_required')
    RETURNING id
  `;
}

async function loadLatestAttempt(
  transaction: TransactionSql,
  tenantId: string,
  jobId: string,
): Promise<LatestAttemptRow | undefined> {
  const rows = await transaction<LatestAttemptRow[]>`
    SELECT attempt_no AS "attemptNo",error_code AS "errorCode",status FROM publish_attempts
    WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${jobId}::uuid
    ORDER BY attempt_no DESC LIMIT 1
  `;
  return rows[0];
}

function browserPlatformLabel(platformCode: 'baijiahao' | 'lieju' | 'sohu'): string {
  return platformCode === 'sohu' ? '搜狐号' : platformCode === 'lieju' ? '列举网' : '百家号';
}

function isBrowserPlatform(value: PlatformCode): value is 'baijiahao' | 'lieju' | 'sohu' {
  return value === 'baijiahao' || value === 'lieju' || value === 'sohu';
}

function attemptRequiresManualResolution(attempt: LatestAttemptRow): boolean {
  return (
    attempt.status === 'unknown' ||
    (attempt.status === 'failed' && attempt.errorCode === 'MANUAL_REQUIRED')
  );
}

async function confirmBaijiahaoAutomationPublished(
  transaction: TransactionSql,
  tenantId: string,
  publishJobId: string,
  publishedAt: Date,
): Promise<void> {
  const runs = await transaction<{ id: string }[]>`
    UPDATE baijiahao_automation_runs SET
      status='published',last_error_json=NULL,finished_at=${publishedAt.toISOString()}::timestamptz,
      version=version+1
    WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
      AND status IN ('scheduled','publishing','processing','manual_required','publish_failed')
    RETURNING id
  `;
  if (runs.length !== 1) throw stateInvalid('Baijiahao automation run is inconsistent');
  const items = await transaction<{ batchId: string }[]>`
    UPDATE baijiahao_daily_batch_items SET
      status='published',published_at=${publishedAt.toISOString()}::timestamptz,last_error_json=NULL
    WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
      AND status IN ('scheduled','processing','manual_required','publish_failed')
    RETURNING batch_id AS "batchId"
  `;
  const batchId = items[0]?.batchId;
  if (!batchId) return;
  await transaction`
    UPDATE baijiahao_daily_batches AS batch SET
      status='completed',completed_at=${publishedAt.toISOString()}::timestamptz,
      last_error_json=NULL,version=version+1
    WHERE batch.id=${batchId}::uuid AND batch.tenant_id=${tenantId}::uuid
      AND batch.status IN ('running','scheduled','attention_required')
      AND NOT EXISTS (
        SELECT 1 FROM baijiahao_daily_batch_items AS item
        WHERE item.tenant_id=batch.tenant_id AND item.batch_id=batch.id
          AND item.status NOT IN ('published','skipped','reserve','retired')
      )
  `;
}

async function confirmBrowserPlatformAutomationPublished(
  transaction: TransactionSql,
  tenantId: string,
  publishJobId: string,
  publishedAt: Date,
): Promise<void> {
  const runs = await transaction<{ id: string }[]>`
    UPDATE browser_platform_automation_runs SET
      status='published',last_error_json=NULL,finished_at=${publishedAt.toISOString()}::timestamptz,
      version=version+1
    WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
      AND status IN ('scheduled','publishing','processing','manual_required','publish_failed')
    RETURNING id
  `;
  if (runs.length !== 1) throw stateInvalid('Browser-platform automation run is inconsistent');
  const items = await transaction<{ batchId: string }[]>`
    UPDATE browser_platform_daily_batch_items SET
      status='published',published_at=${publishedAt.toISOString()}::timestamptz,last_error_json=NULL
    WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
      AND status IN ('scheduled','processing','manual_required','publish_failed')
    RETURNING batch_id AS "batchId"
  `;
  const batchId = items[0]?.batchId;
  if (!batchId) return;
  await transaction`
    UPDATE browser_platform_daily_batches AS batch SET
      status='completed',completed_at=${publishedAt.toISOString()}::timestamptz,
      last_error_json=NULL,version=version+1
    WHERE batch.id=${batchId}::uuid AND batch.tenant_id=${tenantId}::uuid
      AND batch.status IN ('running','scheduled','attention_required')
      AND NOT EXISTS (
        SELECT 1 FROM browser_platform_daily_batch_items AS item
        WHERE item.tenant_id=batch.tenant_id AND item.batch_id=batch.id
          AND item.status NOT IN ('published','retired')
      )
  `;
}

async function disableAutomationRun(
  transaction: TransactionSql,
  tenantId: string,
  publishJobId: string,
  origin: AutomatedOrigin,
  reason: string,
): Promise<void> {
  if (origin === 'baijiahao_automation') {
    const rows = await transaction<{ id: string }[]>`
      UPDATE baijiahao_automation_runs SET
        status='disabled',
        last_error_json=${JSON.stringify({
          code: 'PUBLISH_CANCELLED_BY_USER',
          message: reason,
          schema_version: 'baijiahao-automation-error@1',
        })}::text::jsonb,
        finished_at=now(),version=version+1
      WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
        AND status IN ('scheduled','publishing','processing','manual_required','publish_failed')
      RETURNING id
    `;
    if (rows.length !== 1) throw stateInvalid('Baijiahao automation run is inconsistent');
    await transaction`
      UPDATE baijiahao_daily_batch_items SET status='retired',
        publish_job_id=NULL,scheduled_at=NULL,qualified_at=NULL,
        last_error_json=jsonb_build_object(
          'code','PUBLISH_CANCELLED_BY_USER','message',${reason}::text,
          'schema_version','baijiahao-daily-error@1',
          'source_publish_job_id',${publishJobId}::text
        )
      WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
        AND status IN ('scheduled','processing','manual_required','publish_failed')
    `;
    return;
  }
  if (isBrowserPlatformAutomatedOrigin(origin)) {
    const rows = await transaction<{ id: string }[]>`
      UPDATE browser_platform_automation_runs SET
        status='disabled',
        last_error_json=${JSON.stringify({
          code: 'PUBLISH_CANCELLED_BY_USER',
          message: reason,
          schema_version: 'browser-platform-automation-error@1',
        })}::text::jsonb,
        finished_at=now(),version=version+1
      WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
        AND status IN ('scheduled','publishing','processing','manual_required','publish_failed')
      RETURNING id
    `;
    if (rows.length !== 1) throw stateInvalid('Browser-platform automation run is inconsistent');
    await transaction`
      UPDATE browser_platform_daily_batch_items SET status='retired',
        publish_job_id=NULL,scheduled_at=NULL,qualified_at=NULL,
        last_error_json=jsonb_build_object(
          'code','PUBLISH_CANCELLED_BY_USER','message',${reason}::text,
          'schema_version','browser-platform-daily-error@1',
          'source_publish_job_id',${publishJobId}::text
        )
      WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
        AND status IN ('scheduled','processing','manual_required','publish_failed')
    `;
    return;
  }
  const rows = await transaction<{ id: string }[]>`
    UPDATE official_site_automation_runs SET
      status='disabled',
      last_error_json=${JSON.stringify({
        code: 'PUBLISH_CANCELLED_BY_USER',
        message: reason,
        schema_version: 'official-site-automation-error@1',
      })}::text::jsonb,
      finished_at=now(), version=version+1
    WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
      AND status='publishing'
    RETURNING id
  `;
  if (rows.length !== 1) throw stateInvalid('Official-site automation run is inconsistent');
  await transaction`
    UPDATE official_site_daily_batch_items SET status='retired',
      publish_job_id=NULL,scheduled_at=NULL,qualified_at=NULL,
      last_error_json=jsonb_build_object(
        'code','PUBLISH_CANCELLED_BY_USER','message',${reason}::text,
        'schema_version','official-site-daily-error@1',
        'source_publish_job_id',${publishJobId}::text
      )
    WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
      AND status IN ('scheduled','publish_failed')
  `;
}

async function restartAutomationRun(
  transaction: TransactionSql,
  tenantId: string,
  publishJobId: string,
  origin: AutomatedOrigin,
  expectedStatus: 'disabled' | 'manual_required' | 'publish_failed',
): Promise<void> {
  if (origin === 'baijiahao_automation') {
    const rows = await transaction<{ id: string }[]>`
      UPDATE baijiahao_automation_runs SET
        status='scheduled',last_error_json=NULL,finished_at=NULL,version=version+1
      WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
        AND status=${expectedStatus}
      RETURNING id
    `;
    if (rows.length !== 1) throw stateInvalid('Baijiahao automation run is inconsistent');
    return;
  }
  if (isBrowserPlatformAutomatedOrigin(origin)) {
    const rows = await transaction<{ id: string }[]>`
      UPDATE browser_platform_automation_runs SET
        status='scheduled',last_error_json=NULL,finished_at=NULL,version=version+1
      WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
        AND status=${expectedStatus}
      RETURNING id
    `;
    if (rows.length !== 1) throw stateInvalid('Browser-platform automation run is inconsistent');
    return;
  }
  const rows = await transaction<{ id: string }[]>`
    UPDATE official_site_automation_runs SET
      status='publishing', last_error_json=NULL, finished_at=NULL, version=version+1
    WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
      AND status=${expectedStatus}
    RETURNING id
  `;
  if (rows.length !== 1) throw stateInvalid('Official-site automation run is inconsistent');
}

async function syncDailyBatchSchedule(
  transaction: TransactionSql,
  tenantId: string,
  publishJobId: string,
  origin: AutomatedOrigin,
  scheduledAtIso: string,
): Promise<void> {
  if (origin === 'baijiahao_automation') {
    await transaction`
      UPDATE baijiahao_daily_batch_items SET
        status='scheduled',publish_job_id=${publishJobId}::uuid,
        scheduled_at=${scheduledAtIso}::timestamptz,
        qualified_at=COALESCE(qualified_at,now()),last_error_json=NULL
      WHERE tenant_id=${tenantId}::uuid
        AND (
          publish_job_id=${publishJobId}::uuid
          OR (
            status='retired'
            AND last_error_json->>'code'='PUBLISH_CANCELLED_BY_USER'
            AND last_error_json->>'source_publish_job_id'=${publishJobId}
          )
        )
        AND status IN ('retired','scheduled','manual_required','publish_failed')
    `;
    return;
  }
  if (isBrowserPlatformAutomatedOrigin(origin)) {
    await transaction`
      UPDATE browser_platform_daily_batch_items SET
        status='scheduled',publish_job_id=${publishJobId}::uuid,
        scheduled_at=${scheduledAtIso}::timestamptz,
        qualified_at=COALESCE(qualified_at,now()),last_error_json=NULL
      WHERE tenant_id=${tenantId}::uuid
        AND (
          publish_job_id=${publishJobId}::uuid
          OR (
            status='retired'
            AND last_error_json->>'code'='PUBLISH_CANCELLED_BY_USER'
            AND last_error_json->>'source_publish_job_id'=${publishJobId}
          )
        )
        AND status IN ('retired','scheduled','manual_required','publish_failed')
    `;
    return;
  }
  const items = await transaction<{ batchId: string }[]>`
    UPDATE official_site_daily_batch_items SET
      status='scheduled',publish_job_id=${publishJobId}::uuid,
      scheduled_at=${scheduledAtIso}::timestamptz,
      qualified_at=COALESCE(qualified_at,now()),last_error_json=NULL
    WHERE tenant_id=${tenantId}::uuid
      AND (
        publish_job_id=${publishJobId}::uuid
        OR (
          status='retired'
          AND last_error_json->>'code'='PUBLISH_CANCELLED_BY_USER'
          AND last_error_json->>'source_publish_job_id'=${publishJobId}
        )
      )
      AND status IN ('retired','scheduled','publish_failed')
    RETURNING batch_id AS "batchId"
  `;
  const batchId = items[0]?.batchId;
  if (!batchId) return;
  await transaction`
    UPDATE official_site_daily_batches AS batch SET
      status='scheduled',last_error_json=NULL,version=batch.version+1
    FROM official_site_daily_batches AS source
    WHERE source.id=${batchId}::uuid AND source.tenant_id=${tenantId}::uuid
      AND batch.tenant_id=source.tenant_id AND batch.policy_id=source.policy_id
      AND batch.business_date=source.business_date
      AND batch.status='attention_required'
      AND batch.last_error_json->>'code'='DAILY_PUBLISH_FAILED'
      AND batch.attempt_no=(
        SELECT max(latest.attempt_no)
        FROM official_site_daily_batches AS latest
        WHERE latest.tenant_id=source.tenant_id AND latest.policy_id=source.policy_id
          AND latest.business_date=source.business_date
      )
      AND NOT EXISTS (
        SELECT 1
        FROM official_site_daily_batches AS day_batch
        JOIN official_site_daily_batch_items AS day_item
          ON day_item.batch_id=day_batch.id AND day_item.tenant_id=day_batch.tenant_id
        WHERE day_batch.tenant_id=source.tenant_id AND day_batch.policy_id=source.policy_id
          AND day_batch.business_date=source.business_date
          AND day_item.status='publish_failed'
      )
  `;
}

function isAutomatedOrigin(origin: JobRow['origin']): origin is AutomatedOrigin {
  return origin !== 'manual';
}

function isBrowserPlatformAutomatedOrigin(
  origin: JobRow['origin'],
): origin is BrowserPlatformAutomatedOrigin {
  return origin === 'sohu_automation' || origin === 'lieju_automation';
}

function automationTransitionCause(
  origin: AutomatedOrigin,
): 'baijiahao_automation' | 'browser_platform_automation' | 'official_site_automation' {
  return isBrowserPlatformAutomatedOrigin(origin) ? 'browser_platform_automation' : origin;
}

async function supersedePendingExecution(
  transaction: TransactionSql,
  tenantId: string,
  publishJobId: string,
): Promise<void> {
  await transaction`
    UPDATE outbox_events SET
      status='failed', last_error='Superseded by publish job reschedule'
    WHERE tenant_id=${tenantId}::uuid
      AND aggregate_type='publish_job' AND aggregate_id=${publishJobId}::uuid
      AND event_type='publishing.job.execution_requested.v1' AND status='pending'
  `;
}

function requireInsertedJob(rows: JobRow[], target: PublishTarget): JobRow {
  const row = rows[0];
  if (!row) throw stateInvalid('Publish job insert returned no row');
  return {
    ...row,
    accountCapabilities: target.accountCapabilities,
    accountDeletedAt: target.accountDeletedAt,
    accountPublishMode: target.accountPublishMode,
    accountStatus: target.accountStatus,
    accountTokenExpiresAt: target.accountTokenExpiresAt,
    isRequired: target.isRequired,
    packageId: target.packageId,
    packageStatus: target.packageStatus,
    packageVersion: target.packageVersion,
    platformCode: target.platformCode,
    variantCurrentContentVersionId: target.contentVersionId,
    variantStatus: target.variantStatus,
    variantVersion: target.variantVersion,
  };
}

function requireChangedJob(rows: JobRow[], before: JobRow): JobRow {
  const row = rows[0];
  if (!row) throw versionConflict();
  return {
    ...row,
    accountCapabilities: before.accountCapabilities,
    accountDeletedAt: before.accountDeletedAt,
    accountPublishMode: before.accountPublishMode,
    accountStatus: before.accountStatus,
    accountTokenExpiresAt: before.accountTokenExpiresAt,
    isRequired: before.isRequired,
    packageId: before.packageId,
    packageStatus: before.packageStatus,
    packageVersion: before.packageVersion,
    platformCode: before.platformCode,
    variantCurrentContentVersionId: before.variantCurrentContentVersionId,
    variantStatus: before.variantStatus,
    variantVersion: before.variantVersion,
  };
}

function mapJob(row: JobRow): PublishJobView {
  return {
    account_id: row.accountId,
    attempt_count: row.attemptCount,
    content_version_id: row.contentVersionId,
    created_at: isoDate(row.createdAt),
    created_by: row.createdBy,
    external_post_id: row.externalPostId,
    external_url: row.externalUrl,
    id: row.id,
    idempotency_key: row.idempotencyKey,
    last_error: row.lastError,
    origin: row.origin,
    payload_hash: row.payloadHash,
    published_at: row.publishedAt ? isoDate(row.publishedAt) : null,
    scheduled_at: isoDate(row.scheduledAt),
    status: row.status,
    tenant_id: row.tenantId,
    updated_at: isoDate(row.updatedAt),
    variant_id: row.variantId,
    version: row.version,
  };
}

function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function safeJob(row: JobRow): PublishJobView {
  return mapJob(row);
}

function parseDate(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw inputInvalid('scheduled_at is invalid');
  return parsed;
}

function assertIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_KEY.test(value)) throw inputInvalid('Idempotency key is invalid');
}

function assertVersion(value: number): void {
  if (!Number.isInteger(value) || value < 1) throw inputInvalid('Version must be positive');
}

function normalizeReason(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 1_000) {
    throw inputInvalid('Cancellation reason is invalid');
  }
  return normalized;
}

function notFound(): PublishJobError {
  return new PublishJobError('PUBLISH_JOB_NOT_FOUND', 'Publish job target was not found');
}

function stateInvalid(message: string): PublishJobError {
  return new PublishJobError('PUBLISH_JOB_STATE_INVALID', message);
}

function versionConflict(): PublishJobError {
  return new PublishJobError('PUBLISH_JOB_VERSION_CONFLICT', 'Publish job version is stale');
}

function inputInvalid(message: string): PublishJobError {
  return new PublishJobError('PUBLISH_JOB_INPUT_INVALID', message);
}
