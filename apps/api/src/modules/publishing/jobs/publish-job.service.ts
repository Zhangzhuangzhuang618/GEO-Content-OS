import type {
  ContentPackageStatus,
  ContentVariantStatus,
  CreatePublishJobRequest,
  PlatformCode,
  PublishJobView,
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
        const restoredStatus =
          before.origin === 'official_site_automation' ? 'quality_passed' : 'approved';
        const cause =
          before.origin === 'official_site_automation'
            ? 'official_site_automation'
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
        if (before.origin === 'official_site_automation') {
          await disableAutomationRun(transaction, scope.tenantId, before.id, normalizedReason);
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

  public async retryInTransaction(
    transaction: TransactionSql,
    scope: PublishJobScope,
    jobId: string,
    expectedVersion: number,
    input: RetryPublishRequest,
    scheduledAt = input.scheduled_at ? parseDate(input.scheduled_at) : new Date(),
  ): Promise<PublishJobView> {
    assertVersion(expectedVersion);
    const before = await loadJob(transaction, scope, jobId);
    if (before.version !== expectedVersion) throw versionConflict();
    if (before.status !== 'failed' || before.variantStatus !== 'publish_failed') {
      throw stateInvalid('Only a failed publish job with a failed variant can be retried');
    }
    if (before.packageStatus === 'archived' || before.packageStatus === 'cancelled') {
      throw stateInvalid('Terminal content package cannot be retried');
    }
    const attemptLimit = before.origin === 'official_site_automation' ? 3 : 20;
    if (before.attemptCount >= attemptLimit) {
      throw stateInvalid('Publish job attempt limit was reached');
    }
    if (before.variantCurrentContentVersionId !== before.contentVersionId) {
      throw stateInvalid('The failed publish job no longer points to the current content version');
    }
    if (await latestAttemptIsUnknown(transaction, scope.tenantId, before.id)) {
      throw stateInvalid('Unknown external publish state requires manual resolution');
    }
    assertAccountReady(before);
    const scheduledAtIso = scheduledAt.toISOString();
    const rows = await transaction<JobRow[]>`
        UPDATE publish_jobs SET
          status='scheduled', scheduled_at=${scheduledAtIso}::timestamptz,
          last_error_json=NULL, version=version+1
        WHERE id=${before.id}::uuid AND tenant_id=${scope.tenantId}::uuid
          AND version=${expectedVersion} AND status='failed'
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
    const restoredStatus =
      before.origin === 'official_site_automation' ? 'quality_passed' : 'approved';
    const transitionCause =
      before.origin === 'official_site_automation' ? 'official_site_automation' : 'normal';
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
    assertContentVariantTransition({
      cause: transitionCause,
      from: restoredStatus,
      to: 'scheduled',
    });
    await updateVariant(
      transaction,
      scope.tenantId,
      before.variantId,
      before.variantVersion + 1,
      restoredStatus,
      'scheduled',
    );
    if (before.origin === 'official_site_automation') {
      await restartAutomationRun(transaction, scope.tenantId, before.id);
    }
    await projectPackage(
      transaction,
      this.projector,
      scope.tenantId,
      before.packageId,
      before.packageStatus,
      before.packageVersion,
    );
    await enqueueExecution(transaction, this.outbox, scope, after, scheduledAt);
    await this.audit.record(transaction, {
      action: 'publish_job.retried',
      actorId: scope.userId,
      after: safeJob(after),
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

async function latestAttemptIsUnknown(
  transaction: TransactionSql,
  tenantId: string,
  jobId: string,
): Promise<boolean> {
  const rows = await transaction<{ status: string }[]>`
    SELECT status FROM publish_attempts
    WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${jobId}::uuid
    ORDER BY attempt_no DESC LIMIT 1
  `;
  return rows[0]?.status === 'unknown';
}

async function disableAutomationRun(
  transaction: TransactionSql,
  tenantId: string,
  publishJobId: string,
  reason: string,
): Promise<void> {
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
}

async function restartAutomationRun(
  transaction: TransactionSql,
  tenantId: string,
  publishJobId: string,
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    UPDATE official_site_automation_runs SET
      status='publishing', last_error_json=NULL, finished_at=NULL, version=version+1
    WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
      AND status='publish_failed'
    RETURNING id
  `;
  if (rows.length !== 1) throw stateInvalid('Official-site automation run is inconsistent');
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
