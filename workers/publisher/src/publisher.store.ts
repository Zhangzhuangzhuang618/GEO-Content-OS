import type {
  ContentPackageStatus,
  ContentVariantStatus,
  PlatformCode,
} from '@geo-content-os/contracts';
import { redactSensitiveData } from '@geo-content-os/security';
import type postgres from 'postgres';

import { PublisherError } from './publisher.errors.js';
import type {
  PlatformDelivery,
  PublishClaim,
  PublishClaimResult,
  PublisherStorePort,
  ValidatedPublishEvent,
} from './publisher.types.js';

interface JobRow {
  readonly accountDeletedAt: Date | null;
  readonly accountStatus: 'active' | 'disabled' | 'reauth';
  readonly accountTokenExpiresAt: Date | null;
  readonly attemptCount: number;
  readonly content: Readonly<Record<string, unknown>>;
  readonly contentHash: string;
  readonly contentVersionId: string;
  readonly createdBy: string;
  readonly credentialCiphertext: string | null;
  readonly credentialKeyVersion: string | null;
  readonly currentContentVersionId: string | null;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly origin: 'manual' | 'official_site_automation';
  readonly packageId: string;
  readonly packageStatus: ContentPackageStatus;
  readonly packageVersion: number;
  readonly payloadHash: string;
  readonly platformCode: PlatformCode;
  readonly publishMode: 'api' | 'export' | 'manual';
  readonly scheduledAt: Date;
  readonly status:
    'cancel_requested' | 'cancelled' | 'failed' | 'published' | 'publishing' | 'scheduled';
  readonly tenantId: string;
  readonly updatedAt: Date;
  readonly variantId: string;
  readonly variantStatus: ContentVariantStatus;
  readonly variantVersion: number;
  readonly version: number;
}

interface CompletionRow {
  readonly attemptCount: number;
  readonly createdBy: string;
  readonly packageId: string;
  readonly packageStatus: ContentPackageStatus;
  readonly packageVersion: number;
  readonly origin: 'manual' | 'official_site_automation';
  readonly status: 'cancel_requested' | 'publishing';
  readonly variantId: string;
  readonly variantStatus: ContentVariantStatus;
  readonly variantVersion: number;
}

interface ProjectionRow {
  readonly isRequired: boolean;
  readonly status: ContentVariantStatus;
}

const TERMINAL_JOB_STATUSES = new Set(['cancelled', 'failed', 'published']);
const EDITABLE_VARIANT_STATUSES = new Set<ContentVariantStatus>([
  'generated',
  'published',
  'quality_failed',
  'quality_passed',
  'review_approved',
]);

export class PostgresPublisherStore implements PublisherStorePort {
  public constructor(
    private readonly client: postgres.Sql,
    private readonly staleAfterMs = 120_000,
  ) {
    if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1_000 || staleAfterMs > 900_000) {
      throw new TypeError('Publisher stale lease duration is invalid');
    }
  }

  public claim(event: ValidatedPublishEvent): Promise<PublishClaimResult> {
    return this.client.begin(async (transaction) => {
      const rows = await transaction<JobRow[]>`
        SELECT
          job.id, job.tenant_id AS "tenantId", job.content_version_id AS "contentVersionId",
          job.idempotency_key AS "idempotencyKey", job.payload_hash AS "payloadHash",
          job.status, job.attempt_count AS "attemptCount", job.scheduled_at AS "scheduledAt",
          job.created_by AS "createdBy", job.updated_at AS "updatedAt", job.version, job.origin,
          variant.id AS "variantId", variant.status AS "variantStatus",
          variant.version AS "variantVersion",
          variant.current_content_version_id AS "currentContentVersionId",
          variant.platform_code AS "platformCode", package.id AS "packageId",
          package.status AS "packageStatus", package.version AS "packageVersion",
          content_version.content_json AS content, content_version.content_hash AS "contentHash",
          account.credential_ciphertext AS "credentialCiphertext",
          account.credential_key_version AS "credentialKeyVersion",
          account.publish_mode AS "publishMode", account.status AS "accountStatus",
          account.token_expires_at AS "accountTokenExpiresAt",
          account.deleted_at AS "accountDeletedAt"
        FROM publish_jobs AS job
        JOIN content_variants AS variant
          ON variant.id=job.variant_id AND variant.tenant_id=job.tenant_id
        JOIN content_packages AS package
          ON package.id=variant.package_id AND package.tenant_id=variant.tenant_id
        JOIN content_versions AS content_version
          ON content_version.id=job.content_version_id AND content_version.tenant_id=job.tenant_id
          AND content_version.package_id=package.id AND content_version.variant_id=variant.id
        JOIN platform_accounts AS account
          ON account.id=job.account_id AND account.tenant_id=job.tenant_id
          AND account.workspace_id=package.workspace_id
          AND account.platform_code=variant.platform_code
        WHERE job.id=${event.jobId}::uuid AND job.tenant_id=${event.tenantId}::uuid
        FOR UPDATE OF job, variant, package, account
      `;
      const row = rows[0];
      if (!row) throw scopeInvalid();
      if (TERMINAL_JOB_STATUSES.has(row.status)) return { kind: 'completed' } as const;
      if (
        row.payloadHash !== row.contentHash ||
        row.currentContentVersionId !== row.contentVersionId ||
        event.jobVersion > row.version
      ) {
        throw scopeInvalid();
      }
      if (row.packageStatus === 'archived' || row.packageStatus === 'cancelled') {
        throw stateInvalid();
      }
      if (row.scheduledAt > new Date()) return { kind: 'busy' } as const;

      let attempt = row.attemptCount;
      if (row.status === 'publishing' || row.status === 'cancel_requested') {
        if (!isStale(row.updatedAt, this.staleAfterMs)) return { kind: 'busy' } as const;
        if (attempt < 1) throw stateInvalid();
        const refreshed = await transaction<{ id: string }[]>`
          UPDATE publish_jobs SET version=version+1
          WHERE id=${row.id}::uuid AND tenant_id=${row.tenantId}::uuid
            AND status=${row.status} AND version=${row.version}
          RETURNING id
        `;
        if (refreshed.length !== 1) throw leaseLost();
      } else if (row.status === 'scheduled') {
        if (attempt >= 20) throw stateInvalid();
        const updated = await transaction<{ attempt: number }[]>`
          UPDATE publish_jobs
          SET status='publishing', attempt_count=attempt_count+1, last_error_json=NULL,
              version=version+1
          WHERE id=${row.id}::uuid AND tenant_id=${row.tenantId}::uuid
            AND status='scheduled' AND version=${row.version}
          RETURNING attempt_count AS attempt
        `;
        const lease = updated[0];
        if (!lease) throw leaseLost();
        attempt = lease.attempt;
        await transitionVariant(
          transaction,
          row.tenantId,
          row.variantId,
          row.variantVersion,
          'scheduled',
          'publishing',
        );
        await projectPackage(
          transaction,
          row.tenantId,
          row.packageId,
          row.packageStatus,
          row.packageVersion,
        );
      } else {
        throw stateInvalid();
      }

      const citations = await transaction<{ citation_id: string; label: string; url: string }[]>`
        SELECT citation.id::text AS citation_id, source.title AS label,
          COALESCE(chunk.metadata_json->>'url', source.uri) AS url
        FROM ai_citations AS citation
        JOIN source_chunks AS chunk
          ON chunk.id=citation.chunk_id AND chunk.tenant_id=citation.tenant_id
        JOIN source_documents AS source
          ON source.id=chunk.source_document_id AND source.tenant_id=chunk.tenant_id
        WHERE citation.tenant_id=${row.tenantId}::uuid
          AND citation.content_version_id=${row.contentVersionId}::uuid
          AND COALESCE(chunk.metadata_json->>'url', source.uri) ~* '^https?://'
        ORDER BY citation.claim_key, citation.id
      `;
      return {
        kind: 'claimed',
        value: Object.freeze({
          accountStatus: row.accountDeletedAt === null ? row.accountStatus : 'disabled',
          accountTokenExpiresAt: row.accountTokenExpiresAt,
          attempt,
          citations: Object.freeze(citations.map((citation) => Object.freeze(citation))),
          content: Object.freeze(row.content),
          contentVersionId: row.contentVersionId,
          credentialCiphertext: row.credentialCiphertext,
          credentialKeyVersion: row.credentialKeyVersion,
          idempotencyKey: row.idempotencyKey,
          jobId: row.id,
          payloadHash: row.payloadHash,
          platformCode: row.platformCode,
          publishMode: row.publishMode,
          tenantId: row.tenantId,
        }),
      } as const;
    });
  }

  public complete(
    event: ValidatedPublishEvent,
    claim: PublishClaim,
    delivery: PlatformDelivery,
    artifact?: {
      readonly contentHash: string;
      readonly manifest: Readonly<Record<string, unknown>>;
      readonly objectUri: string;
    },
  ): Promise<void> {
    return this.client.begin(async (transaction) => {
      const row = await lockCompletion(transaction, event, claim);
      if (delivery.mode === 'export' && !artifact) throw stateInvalid();
      if (delivery.mode === 'api' && artifact) throw stateInvalid();
      await insertAttempt(transaction, claim, {
        errorCode: null,
        requestHash: delivery.payloadHash,
        response:
          delivery.mode === 'api'
            ? { ...delivery.response, external_id: delivery.externalId, url: delivery.url }
            : { mode: 'export', object_uri: artifact?.objectUri },
        status: 'succeeded',
      });
      if (delivery.mode === 'export' && artifact) {
        await transaction`
          INSERT INTO export_artifacts (
            tenant_id, variant_id, content_version_id, publish_job_id, object_uri,
            manifest_json, content_hash, expires_at, created_by
          ) VALUES (
            ${claim.tenantId}::uuid, ${row.variantId}::uuid, ${claim.contentVersionId}::uuid,
            ${claim.jobId}::uuid, ${artifact.objectUri},
            ${JSON.stringify(artifact.manifest)}::text::jsonb, ${artifact.contentHash},
            now()+interval '7 days', ${row.createdBy}::uuid
          )
        `;
      }
      const updated = await transaction<{ id: string }[]>`
        UPDATE publish_jobs SET
          status='published', external_post_id=${delivery.mode === 'api' ? delivery.externalId : null},
          external_url=${delivery.mode === 'api' ? delivery.url : null},
          published_at=${delivery.mode === 'api' ? publishedAt(delivery) : null},
          last_error_json=NULL,
          version=version+1
        WHERE id=${claim.jobId}::uuid AND tenant_id=${claim.tenantId}::uuid
          AND status IN ('publishing','cancel_requested') AND attempt_count=${claim.attempt}
        RETURNING id
      `;
      if (updated.length !== 1) throw leaseLost();
      if (row.origin === 'official_site_automation') {
        await completeAutomationRun(transaction, claim.tenantId, claim.jobId, 'published', null);
        await completeDailyBatchItem(transaction, claim.tenantId, claim.jobId, delivery);
      }
      await transitionVariant(
        transaction,
        claim.tenantId,
        row.variantId,
        row.variantVersion,
        'publishing',
        'published',
      );
      await projectPackage(
        transaction,
        claim.tenantId,
        row.packageId,
        row.packageStatus,
        row.packageVersion,
      );
      await writeAudit(
        transaction,
        event,
        row.createdBy,
        'publish_job.published',
        claim,
        {
          attempt: claim.attempt,
          external_id: delivery.mode === 'api' ? delivery.externalId : null,
          mode: delivery.mode,
          status: 'published',
        },
        row.status,
      );
    });
  }

  public fail(
    event: ValidatedPublishEvent,
    claim: PublishClaim,
    failure: {
      readonly code: string;
      readonly message: string;
      readonly requestHash: string;
      readonly status: 'failed' | 'unknown';
    },
  ): Promise<void> {
    return this.client.begin(async (transaction) => {
      const row = await lockCompletion(transaction, event, claim);
      await insertAttempt(transaction, claim, {
        errorCode: failure.code,
        requestHash: failure.requestHash,
        response: { message: failure.message },
        status: failure.status,
      });
      const error = adapterError(failure.code, failure.message);
      const updated = await transaction<{ id: string }[]>`
        UPDATE publish_jobs SET status='failed', last_error_json=${JSON.stringify(error)}::text::jsonb,
          version=version+1
        WHERE id=${claim.jobId}::uuid AND tenant_id=${claim.tenantId}::uuid
          AND status IN ('publishing','cancel_requested') AND attempt_count=${claim.attempt}
        RETURNING id
      `;
      if (updated.length !== 1) throw leaseLost();
      if (row.origin === 'official_site_automation') {
        await completeAutomationRun(
          transaction,
          claim.tenantId,
          claim.jobId,
          'publish_failed',
          error,
        );
        await failDailyBatchItem(transaction, claim.tenantId, claim.jobId, error);
      }
      await transitionVariant(
        transaction,
        claim.tenantId,
        row.variantId,
        row.variantVersion,
        'publishing',
        'publish_failed',
      );
      await projectPackage(
        transaction,
        claim.tenantId,
        row.packageId,
        row.packageStatus,
        row.packageVersion,
      );
      await writeAudit(
        transaction,
        event,
        row.createdBy,
        'publish_job.failed',
        claim,
        {
          attempt: claim.attempt,
          error_code: failure.code,
          status: failure.status,
        },
        row.status,
      );
    });
  }

  public retry(
    event: ValidatedPublishEvent,
    claim: PublishClaim,
    failure: { readonly code: string; readonly message: string; readonly requestHash: string },
  ): Promise<void> {
    return this.client.begin(async (transaction) => {
      const row = await lockCompletion(transaction, event, claim);
      await insertAttempt(transaction, claim, {
        errorCode: failure.code,
        requestHash: failure.requestHash,
        response: { message: failure.message },
        status: 'failed',
      });
      const error = adapterError(failure.code, failure.message);
      if (row.status === 'cancel_requested') {
        const cancelled = await transaction<{ id: string }[]>`
          UPDATE publish_jobs SET status='cancelled', last_error_json=${JSON.stringify(error)}::text::jsonb,
            version=version+1
          WHERE id=${claim.jobId}::uuid AND tenant_id=${claim.tenantId}::uuid
            AND status='cancel_requested' AND attempt_count=${claim.attempt}
          RETURNING id
        `;
        if (cancelled.length !== 1) throw leaseLost();
        if (row.origin === 'official_site_automation') {
          await completeAutomationRun(transaction, claim.tenantId, claim.jobId, 'disabled', {
            code: 'PUBLISH_CANCELLED_BY_USER',
            message: failure.message,
            schema_version: 'official-site-automation-error@1',
          });
        }
        await transitionVariant(
          transaction,
          claim.tenantId,
          row.variantId,
          row.variantVersion,
          'publishing',
          row.origin === 'official_site_automation' ? 'quality_passed' : 'approved',
        );
        await projectPackage(
          transaction,
          claim.tenantId,
          row.packageId,
          row.packageStatus,
          row.packageVersion,
        );
        await writeAudit(
          transaction,
          event,
          row.createdBy,
          'publish_job.cancelled',
          claim,
          { attempt: claim.attempt, error_code: failure.code, status: 'cancelled' },
          row.status,
        );
        return;
      }
      const updated = await transaction<{ id: string }[]>`
        UPDATE publish_jobs SET status='scheduled', scheduled_at=now(),
          last_error_json=${JSON.stringify(error)}::text::jsonb, version=version+1
        WHERE id=${claim.jobId}::uuid AND tenant_id=${claim.tenantId}::uuid
          AND status='publishing' AND attempt_count=${claim.attempt}
        RETURNING id
      `;
      if (updated.length !== 1) throw leaseLost();
      await transitionVariant(
        transaction,
        claim.tenantId,
        row.variantId,
        row.variantVersion,
        'publishing',
        'publish_failed',
      );
      await transitionVariant(
        transaction,
        claim.tenantId,
        row.variantId,
        row.variantVersion + 1,
        'publish_failed',
        row.origin === 'official_site_automation' ? 'quality_passed' : 'approved',
      );
      await transitionVariant(
        transaction,
        claim.tenantId,
        row.variantId,
        row.variantVersion + 2,
        row.origin === 'official_site_automation' ? 'quality_passed' : 'approved',
        'scheduled',
      );
      await projectPackage(
        transaction,
        claim.tenantId,
        row.packageId,
        row.packageStatus,
        row.packageVersion,
      );
      await writeAudit(
        transaction,
        event,
        row.createdBy,
        'publish_job.retry_scheduled',
        claim,
        {
          attempt: claim.attempt,
          error_code: failure.code,
          status: 'scheduled',
        },
        row.status,
      );
    });
  }
}

async function lockCompletion(
  transaction: postgres.TransactionSql,
  event: ValidatedPublishEvent,
  claim: PublishClaim,
): Promise<CompletionRow> {
  const rows = await transaction<CompletionRow[]>`
    SELECT job.status, job.attempt_count AS "attemptCount", job.created_by AS "createdBy",
      job.origin,
      variant.id AS "variantId", variant.status AS "variantStatus",
      variant.version AS "variantVersion", package.id AS "packageId",
      package.status AS "packageStatus", package.version AS "packageVersion"
    FROM publish_jobs AS job
    JOIN content_variants AS variant
      ON variant.id=job.variant_id AND variant.tenant_id=job.tenant_id
    JOIN content_packages AS package
      ON package.id=variant.package_id AND package.tenant_id=variant.tenant_id
    WHERE job.id=${claim.jobId}::uuid AND job.tenant_id=${event.tenantId}::uuid
      AND job.content_version_id=${claim.contentVersionId}::uuid
    FOR UPDATE OF job, variant, package
  `;
  const row = rows[0];
  if (
    !row ||
    row.attemptCount !== claim.attempt ||
    (row.status !== 'publishing' && row.status !== 'cancel_requested') ||
    row.variantStatus !== 'publishing'
  ) {
    throw leaseLost();
  }
  return row;
}

async function insertAttempt(
  transaction: postgres.TransactionSql,
  claim: PublishClaim,
  value: {
    readonly errorCode: string | null;
    readonly requestHash: string;
    readonly response: Readonly<Record<string, unknown>>;
    readonly status: 'failed' | 'succeeded' | 'unknown';
  },
): Promise<void> {
  const response = redactSensitiveData(value.response);
  await transaction`
    INSERT INTO publish_attempts (
      tenant_id, publish_job_id, attempt_no, adapter_code, status, request_hash,
      response_json, error_code, started_at, finished_at
    ) VALUES (
      ${claim.tenantId}::uuid, ${claim.jobId}::uuid, ${claim.attempt},
      ${`${claim.platformCode}-delivery@1.0.0`}, ${value.status}, ${value.requestHash},
      ${JSON.stringify(response)}::text::jsonb, ${value.errorCode}, now(), now()
    )
  `;
}

function publishedAt(delivery: Extract<PlatformDelivery, { readonly mode: 'api' }>): Date {
  const value = delivery.response['published_at'];
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return new Date();
}

async function completeAutomationRun(
  transaction: postgres.TransactionSql,
  tenantId: string,
  publishJobId: string,
  status: 'disabled' | 'publish_failed' | 'published',
  error: Readonly<Record<string, unknown>> | null,
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    UPDATE official_site_automation_runs SET
      status=${status}, last_error_json=${error ? JSON.stringify(error) : null}::text::jsonb,
      finished_at=now(), version=version+1
    WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
      AND status='publishing'
    RETURNING id
  `;
  if (rows.length !== 1) throw stateInvalid();
}

async function completeDailyBatchItem(
  transaction: postgres.TransactionSql,
  tenantId: string,
  publishJobId: string,
  delivery: PlatformDelivery,
): Promise<void> {
  const items = await transaction<{ batchId: string }[]>`
    UPDATE official_site_daily_batch_items SET
      status='published',
      published_at=${delivery.mode === 'api' ? publishedAt(delivery) : new Date()}
    WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
      AND status='scheduled'
    RETURNING batch_id AS "batchId"
  `;
  const batchId = items[0]?.batchId;
  if (!batchId) return;
  await transaction`
    UPDATE official_site_daily_batches AS batch SET
      status='completed',completed_at=now(),last_error_json=NULL,version=version+1
    WHERE batch.id=${batchId}::uuid AND batch.tenant_id=${tenantId}::uuid
      AND batch.status='scheduled'
      AND (
        SELECT count(*) FROM official_site_daily_batch_items AS item
        WHERE item.tenant_id=batch.tenant_id AND item.batch_id=batch.id
          AND item.status='published'
      ) >= 10
  `;
}

async function failDailyBatchItem(
  transaction: postgres.TransactionSql,
  tenantId: string,
  publishJobId: string,
  error: Readonly<Record<string, unknown>>,
): Promise<void> {
  const items = await transaction<{ batchId: string }[]>`
    UPDATE official_site_daily_batch_items SET
      status='publish_failed',
      last_error_json=${JSON.stringify(error)}::text::jsonb
    WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
      AND status='scheduled'
    RETURNING batch_id AS "batchId"
  `;
  const batchId = items[0]?.batchId;
  if (!batchId) return;
  await transaction`
    UPDATE official_site_daily_batches SET
      status='attention_required',
      last_error_json=${JSON.stringify({
        code: 'DAILY_PUBLISH_FAILED',
        message: '官网发布重试 3 次后仍失败，请检查官网连接。',
        schema_version: 'official-site-daily-error@1',
      })}::text::jsonb,
      version=version+1
    WHERE id=${batchId}::uuid AND tenant_id=${tenantId}::uuid
      AND status='scheduled'
  `;
}

async function transitionVariant(
  transaction: postgres.TransactionSql,
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
  if (rows.length !== 1) throw leaseLost();
}

async function projectPackage(
  transaction: postgres.TransactionSql,
  tenantId: string,
  packageId: string,
  currentStatus: ContentPackageStatus,
  packageVersion: number,
): Promise<void> {
  const variants = await transaction<ProjectionRow[]>`
    SELECT status, is_required AS "isRequired"
    FROM content_variants
    WHERE package_id=${packageId}::uuid AND tenant_id=${tenantId}::uuid
    ORDER BY id
  `;
  const status = projectPackageStatus(currentStatus, variants);
  const rows = await transaction<{ id: string }[]>`
    UPDATE content_packages SET status=${status}, version=version+1
    WHERE id=${packageId}::uuid AND tenant_id=${tenantId}::uuid AND version=${packageVersion}
    RETURNING id
  `;
  if (rows.length !== 1) throw leaseLost();
}

function projectPackageStatus(
  currentStatus: ContentPackageStatus,
  variants: readonly ProjectionRow[],
): ContentPackageStatus {
  if (currentStatus === 'archived' || currentStatus === 'cancelled') return currentStatus;
  const required = variants.filter((variant) => variant.isRequired);
  if (required.some((variant) => variant.status === 'publishing')) return 'publishing';
  if (required.some((variant) => variant.status === 'in_review')) return 'in_review';
  if (required.some((variant) => variant.status === 'generating')) return 'generating';
  if (required.some((variant) => variant.status === 'publish_failed')) return 'publish_failed';
  if (required.some((variant) => variant.status === 'scheduled')) return 'scheduled';
  if (required.length > 0 && required.every((variant) => variant.status === 'published'))
    return 'published';
  if (required.some((variant) => variant.status === 'review_rejected')) return 'rejected';
  if (required.some((variant) => variant.status === 'approved')) return 'approved';
  if (required.some((variant) => EDITABLE_VARIANT_STATUSES.has(variant.status))) return 'generated';
  if (required.length > 0 && required.every((variant) => variant.status === 'generation_failed'))
    return 'all_failed';
  return 'draft';
}

async function writeAudit(
  transaction: postgres.TransactionSql,
  event: ValidatedPublishEvent,
  actorId: string,
  action: string,
  claim: PublishClaim,
  after: Readonly<Record<string, unknown>>,
  beforeStatus: string,
): Promise<void> {
  const before = { attempt: claim.attempt, status: beforeStatus };
  await transaction`
    INSERT INTO audit_events (
      tenant_id, actor_id, action, resource_type, resource_id,
      before_json, after_json, request_id
    ) VALUES (
      ${claim.tenantId}::uuid, ${actorId}::uuid, ${action}, 'publish_job',
      ${claim.jobId}::uuid, ${JSON.stringify(redactSensitiveData(before))}::text::jsonb,
      ${JSON.stringify(redactSensitiveData(after))}::text::jsonb, ${event.requestId}
    )
  `;
}

function adapterError(code: string, message: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    code,
    message: message.slice(0, 2_000),
    schema_version: 'adapter-error@1',
  });
}

function isStale(updatedAt: Date, staleAfterMs: number): boolean {
  return updatedAt.getTime() <= Date.now() - staleAfterMs;
}

function scopeInvalid(): PublisherError {
  return new PublisherError('PUBLISHER_SCOPE_INVALID', 'Publish job scope is invalid');
}

function stateInvalid(): PublisherError {
  return new PublisherError('PUBLISHER_STATE_INVALID', 'Publish job state is invalid');
}

function leaseLost(): PublisherError {
  return new PublisherError('PUBLISHER_LEASE_LOST', 'Publish job lease was lost', true);
}
