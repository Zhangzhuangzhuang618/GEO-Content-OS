import type {
  ContentPackageStatus,
  ContentVariantStatus,
  PlatformCode,
} from '@geo-content-os/contracts';
import { redactSensitiveData } from '@geo-content-os/security';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';

import { PublisherError } from './publisher.errors.js';
import type {
  BaijiahaoReconcileClaim,
  BaijiahaoRemoteStatus,
  PlatformDelivery,
  PublishClaim,
  PublishClaimResult,
  PublisherStorePort,
  ValidatedBaijiahaoReconcileEvent,
  ValidatedPublishEvent,
} from './publisher.types.js';

interface JobRow {
  readonly accountId: string;
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
  readonly liejuDeliveryMethod: 'browser_gateway' | 'official_api' | null;
  readonly origin:
    | 'manual'
    | 'official_site_automation'
    | 'baijiahao_automation'
    | 'sohu_automation'
    | 'lieju_automation';
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
  readonly accountId: string;
  readonly attemptCount: number;
  readonly createdBy: string;
  readonly packageId: string;
  readonly packageStatus: ContentPackageStatus;
  readonly packageVersion: number;
  readonly projectId: string;
  readonly origin:
    | 'manual'
    | 'official_site_automation'
    | 'baijiahao_automation'
    | 'sohu_automation'
    | 'lieju_automation';
  readonly status: 'cancel_requested' | 'publishing';
  readonly variantId: string;
  readonly variantStatus: ContentVariantStatus;
  readonly variantVersion: number;
  readonly workspaceId: string;
}

interface ProjectionRow {
  readonly isRequired: boolean;
  readonly status: ContentVariantStatus;
}

interface BaijiahaoReconcileRow extends CompletionRow {
  readonly accountDeletedAt: Date | null;
  readonly accountStatus: 'active' | 'disabled' | 'reauth';
  readonly accountTokenExpiresAt: Date | null;
  readonly contentVersionId: string;
  readonly credentialCiphertext: string | null;
  readonly credentialKeyVersion: string | null;
  readonly externalId: string | null;
  readonly jobVersion: number;
  readonly publishMode: 'api' | 'export' | 'manual';
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
          job.account_id AS "accountId",
          variant.id AS "variantId", variant.status AS "variantStatus",
          variant.version AS "variantVersion",
          variant.current_content_version_id AS "currentContentVersionId",
          variant.platform_code AS "platformCode", package.id AS "packageId",
          package.status AS "packageStatus", package.version AS "packageVersion",
          content_version.content_json AS content, content_version.content_hash AS "contentHash",
          account.credential_ciphertext AS "credentialCiphertext",
          account.credential_key_version AS "credentialKeyVersion",
          account.publish_mode AS "publishMode", account.status AS "accountStatus",
          account.capabilities_json->>'delivery_method' AS "liejuDeliveryMethod",
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
        const attemptLimit = row.origin === 'manual' ? 20 : 3;
        if (attempt >= attemptLimit) throw stateInvalid();
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
      const mediaAssets = await transaction<
        {
          altText: string;
          contentHash: string;
          id: string;
          mimeType: string;
          objectUri: string;
          position: number;
          publicUrl: string | null;
          role: 'body' | 'cover';
          sizeBytes: string;
        }[]
      >`
        SELECT asset.id,asset.object_uri AS "objectUri",asset.content_hash AS "contentHash",
          asset.mime_type AS "mimeType",asset.size_bytes::text AS "sizeBytes",
          link.role,link.position,link.alt_text AS "altText",link.public_url AS "publicUrl"
        FROM content_media_assets AS link
        JOIN media_assets AS asset
          ON asset.id=link.media_asset_id AND asset.tenant_id=link.tenant_id
          AND asset.asset_type='image' AND asset.deleted_at IS NULL
        WHERE link.tenant_id=${row.tenantId}::uuid
          AND link.content_version_id=${row.contentVersionId}::uuid
          AND link.quality_json->>'decision'='pass'
        ORDER BY CASE link.role WHEN 'cover' THEN 0 ELSE 1 END,link.position,link.id
      `;
      return {
        kind: 'claimed',
        value: Object.freeze({
          accountId: row.accountId,
          accountStatus: row.accountDeletedAt === null ? row.accountStatus : 'disabled',
          accountTokenExpiresAt: row.accountTokenExpiresAt,
          attempt,
          citations: Object.freeze(citations.map((citation) => Object.freeze(citation))),
          content: Object.freeze(row.content),
          contentVersionId: row.contentVersionId,
          credentialCiphertext: row.credentialCiphertext,
          credentialKeyVersion: row.credentialKeyVersion,
          idempotencyKey: row.idempotencyKey,
          ...(row.platformCode === 'lieju'
            ? { liejuDeliveryMethod: row.liejuDeliveryMethod ?? 'browser_gateway' }
            : {}),
          jobId: row.id,
          mediaAssets: Object.freeze(
            mediaAssets.map((asset) =>
              Object.freeze({ ...asset, sizeBytes: Number(asset.sizeBytes) }),
            ),
          ),
          payloadHash: row.payloadHash,
          platformCode: row.platformCode,
          publishMode: row.publishMode,
          tenantId: row.tenantId,
        }),
      } as const;
    });
  }

  public reserveLiejuOfficialSubmission(claim: PublishClaim): Promise<boolean> {
    if (claim.platformCode !== 'lieju' || claim.liejuDeliveryMethod !== 'official_api') {
      return Promise.resolve(true);
    }
    return this.client.begin(async (transaction) => {
      const reset = await transaction<{ id: string }[]>`
        UPDATE lieju_api_publications SET
          status='reserved',attempt_no=${claim.attempt},last_error_json=NULL,
          remote_reference=NULL,external_url=NULL,response_hash=NULL,submitted_at=NULL,
          version=version+1
        WHERE tenant_id=${claim.tenantId}::uuid AND publish_job_id=${claim.jobId}::uuid
          AND account_id=${claim.accountId}::uuid
          AND idempotency_key=${claim.idempotencyKey}
          AND status IN ('rejected','not_published')
        RETURNING id
      `;
      if (reset.length === 1) return true;
      const rows = await transaction<{ id: string }[]>`
        INSERT INTO lieju_api_publications (
          tenant_id,account_id,publish_job_id,content_version_id,idempotency_key,
          payload_hash,attempt_no,status
        ) VALUES (
          ${claim.tenantId}::uuid,${claim.accountId}::uuid,${claim.jobId}::uuid,
          ${claim.contentVersionId}::uuid,${claim.idempotencyKey},${claim.payloadHash},
          ${claim.attempt},'reserved'
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      return rows.length === 1;
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
      if (delivery.mode === 'api' && deliveryStatus(delivery) === 'processing') {
        const liejuOfficial = isLiejuOfficial(claim);
        if (
          !liejuOfficial &&
          (!isBrowserPlatform(claim.platformCode) ||
            !isBrowserOrigin(row.origin, claim.platformCode))
        ) {
          throw stateInvalid();
        }
        const processing = await transaction<{ version: number }[]>`
          UPDATE publish_jobs SET
            external_post_id=${delivery.externalId}, external_url=${delivery.url},
            last_error_json=NULL, version=version+1
          WHERE id=${claim.jobId}::uuid AND tenant_id=${claim.tenantId}::uuid
            AND status='publishing' AND attempt_count=${claim.attempt}
          RETURNING version
        `;
        const job = processing[0];
        if (!job) throw leaseLost();
        if (liejuOfficial) {
          const official = await updateLiejuOfficialPublication(
            transaction,
            claim,
            delivery,
            'processing',
          );
          if (official.length !== 1) throw stateInvalid();
        } else {
          const browserPublications = await updateBrowserPublicationProcessing(
            transaction,
            claim,
            delivery,
          );
          if (browserPublications.length !== 1) throw stateInvalid();
        }
        if (row.origin === 'baijiahao_automation') {
          await transaction`
            UPDATE baijiahao_automation_runs SET
              status='processing', last_error_json=NULL, version=version+1
            WHERE tenant_id=${claim.tenantId}::uuid AND publish_job_id=${claim.jobId}::uuid
              AND status IN ('scheduled','publishing')
          `;
          await transaction`
            UPDATE baijiahao_daily_batch_items SET status='processing',last_error_json=NULL
            WHERE tenant_id=${claim.tenantId}::uuid AND publish_job_id=${claim.jobId}::uuid
              AND status='scheduled'
          `;
        } else if (isBrowserPlatformAutomationOrigin(row.origin)) {
          await markBrowserPlatformAutomationProcessing(transaction, claim.tenantId, claim.jobId);
        }
        if (!liejuOfficial && isBrowserPlatform(claim.platformCode)) {
          await insertBrowserReconcileEvent(
            transaction,
            event,
            claim,
            row,
            job.version,
            5,
            1,
            claim.platformCode,
          );
        }
        await writeAudit(
          transaction,
          event,
          row.createdBy,
          'publish_job.processing',
          claim,
          {
            attempt: claim.attempt,
            external_id: delivery.externalId,
            status: 'processing',
          },
          row.status,
        );
        return;
      }
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
      const updated = await transaction<{ version: number }[]>`
        UPDATE publish_jobs SET
          status='published', external_post_id=${delivery.mode === 'api' ? delivery.externalId : null},
          external_url=${delivery.mode === 'api' ? delivery.url : null},
          published_at=${delivery.mode === 'api' ? publishedAt(delivery) : null},
          last_error_json=NULL,
          version=version+1
        WHERE id=${claim.jobId}::uuid AND tenant_id=${claim.tenantId}::uuid
          AND status IN ('publishing','cancel_requested') AND attempt_count=${claim.attempt}
        RETURNING version
      `;
      const publishedJob = updated[0];
      if (!publishedJob) throw leaseLost();
      if (delivery.mode === 'api' && isLiejuOfficial(claim)) {
        const official = await updateLiejuOfficialPublication(
          transaction,
          claim,
          delivery,
          'published',
        );
        if (official.length !== 1) throw stateInvalid();
      }
      if (row.origin === 'official_site_automation') {
        await completeAutomationRun(transaction, claim.tenantId, claim.jobId, 'published', null);
        await completeDailyBatchItem(transaction, claim.tenantId, claim.jobId, delivery);
      } else if (isBrowserPlatform(claim.platformCode)) {
        if (delivery.mode !== 'api') throw stateInvalid();
        if (!isLiejuOfficial(claim)) {
          const browserPublications = await selectPublishedBrowserPublication(
            transaction,
            claim,
            delivery.externalId,
          );
          if (browserPublications.length !== 1) throw stateInvalid();
        }
        if (row.origin === 'baijiahao_automation') {
          await completeBaijiahaoAutomationRun(
            transaction,
            claim.tenantId,
            claim.jobId,
            'published',
            null,
          );
          await completeBaijiahaoDailyBatchItem(
            transaction,
            claim.tenantId,
            claim.jobId,
            'published',
            null,
          );
        } else if (isBrowserPlatformAutomationOrigin(row.origin)) {
          await completeBrowserPlatformAutomation(
            transaction,
            claim.tenantId,
            claim.jobId,
            'published',
            null,
          );
        }
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
      if (delivery.mode === 'api') {
        await insertPublishedEvent(transaction, event, claim, row, delivery, publishedJob.version);
      }
    });
  }

  public fail(
    event: ValidatedPublishEvent,
    claim: PublishClaim,
    failure: {
      readonly code: string;
      readonly diagnostics?: Readonly<Record<string, unknown>>;
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
        response: {
          ...(failure.diagnostics ? { diagnostics: failure.diagnostics } : {}),
          message: failure.message,
        },
        status: failure.status,
      });
      const error = adapterError(failure.code, failure.message, failure.diagnostics);
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
      } else if (row.origin === 'baijiahao_automation') {
        const requiresManualHandling =
          failure.status === 'unknown' || failure.code === 'MANUAL_REQUIRED';
        await completeBaijiahaoAutomationRun(
          transaction,
          claim.tenantId,
          claim.jobId,
          requiresManualHandling ? 'manual_required' : 'publish_failed',
          error,
        );
        if (requiresManualHandling) {
          await transaction`
            UPDATE baijiahao_browser_publications SET
              status='manual_required',review_reason=${failure.message},
              last_reconciled_at=now(),version=version+1
            WHERE tenant_id=${claim.tenantId}::uuid AND publish_job_id=${claim.jobId}::uuid
              AND status IN ('prepared','submitting','unknown','processing')
          `;
        }
        await completeBaijiahaoDailyBatchItem(
          transaction,
          claim.tenantId,
          claim.jobId,
          requiresManualHandling ? 'manual_required' : 'publish_failed',
          error,
        );
      } else if (claim.platformCode === 'sohu' || claim.platformCode === 'lieju') {
        if (isLiejuOfficial(claim)) {
          await updateLiejuOfficialPublicationFailure(transaction, claim, failure, error);
        } else {
          await updateBrowserPublicationFailure(transaction, claim, failure, error);
        }
        if (isBrowserPlatformAutomationOrigin(row.origin)) {
          const manual = failure.status === 'unknown' || failure.code === 'MANUAL_REQUIRED';
          await completeBrowserPlatformAutomation(
            transaction,
            claim.tenantId,
            claim.jobId,
            manual ? 'manual_required' : 'publish_failed',
            error,
          );
        }
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
        } else if (row.origin === 'baijiahao_automation') {
          await completeBaijiahaoAutomationRun(
            transaction,
            claim.tenantId,
            claim.jobId,
            'disabled',
            {
              code: 'PUBLISH_CANCELLED_BY_USER',
              message: failure.message,
              schema_version: 'baijiahao-automation-error@1',
            },
          );
        } else if (isBrowserPlatformAutomationOrigin(row.origin)) {
          await completeBrowserPlatformAutomation(
            transaction,
            claim.tenantId,
            claim.jobId,
            'disabled',
            {
              code: 'PUBLISH_CANCELLED_BY_USER',
              message: failure.message,
              schema_version: 'browser-platform-automation-error@1',
            },
          );
        }
        await transitionVariant(
          transaction,
          claim.tenantId,
          row.variantId,
          row.variantVersion,
          'publishing',
          automatedReadyStatus(row.origin),
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
        automatedReadyStatus(row.origin),
      );
      await transitionVariant(
        transaction,
        claim.tenantId,
        row.variantId,
        row.variantVersion + 2,
        automatedReadyStatus(row.origin),
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

  public claimBaijiahaoReconciliation(
    event: ValidatedBaijiahaoReconcileEvent,
  ): Promise<
    | { readonly kind: 'completed' }
    | { readonly kind: 'claimed'; readonly value: BaijiahaoReconcileClaim }
  > {
    return this.client.begin(async (transaction) => {
      const rows = await selectBaijiahaoReconcileRow(transaction, event, true);
      const row = rows[0];
      if (!row) throw scopeInvalid();
      if (row.status !== 'publishing') return { kind: 'completed' } as const;
      if (row.jobVersion > event.jobVersion) return { kind: 'completed' } as const;
      if (
        row.jobVersion !== event.jobVersion ||
        !isBrowserOrigin(row.origin, event.platformCode) ||
        row.publishMode !== 'api' ||
        row.variantStatus !== 'publishing' ||
        !row.externalId
      ) {
        throw stateInvalid();
      }
      return {
        kind: 'claimed',
        value: Object.freeze({
          accountId: row.accountId,
          accountStatus: row.accountDeletedAt === null ? row.accountStatus : 'disabled',
          accountTokenExpiresAt: row.accountTokenExpiresAt,
          attempt: row.attemptCount,
          contentVersionId: row.contentVersionId,
          credentialCiphertext: row.credentialCiphertext,
          credentialKeyVersion: row.credentialKeyVersion,
          externalId: row.externalId,
          jobId: event.jobId,
          jobVersion: row.jobVersion,
          platformCode: event.platformCode,
          publishMode: 'api',
          tenantId: event.tenantId,
        }),
      } as const;
    });
  }

  public completeBaijiahaoReconciliation(
    event: ValidatedBaijiahaoReconcileEvent,
    claim: BaijiahaoReconcileClaim,
    result: BaijiahaoRemoteStatus,
  ): Promise<'completed' | 'pending'> {
    return this.client.begin(async (transaction) => {
      const rows = await selectBaijiahaoReconcileRow(transaction, event, true);
      const row = rows[0];
      if (!row || row.status !== 'publishing' || row.jobVersion !== claim.jobVersion) {
        return 'completed' as const;
      }
      if (
        claim.platformCode !== event.platformCode ||
        !isBrowserOrigin(row.origin, claim.platformCode) ||
        row.variantStatus !== 'publishing' ||
        row.externalId !== claim.externalId ||
        result.externalId !== claim.externalId
      ) {
        throw stateInvalid();
      }
      if (
        (result.status === 'processing' || result.status === 'unknown') &&
        event.reconcileAttempt < 12
      ) {
        const error =
          result.status === 'unknown'
            ? adapterError(
                `${browserErrorPrefix(claim.platformCode)}_STATUS_UNKNOWN`,
                `${browserPlatformName(claim.platformCode)} status could not be verified; reconciliation will continue.`,
              )
            : null;
        const updated = await transaction<{ version: number }[]>`
          UPDATE publish_jobs SET
            external_url=COALESCE(${result.url}, external_url),
            last_error_json=${error ? JSON.stringify(error) : null}::text::jsonb,
            version=version+1
          WHERE id=${claim.jobId}::uuid AND tenant_id=${claim.tenantId}::uuid
            AND status='publishing' AND version=${claim.jobVersion}
          RETURNING version
        `;
        const job = updated[0];
        if (!job) throw leaseLost();
        const browserPublications = await updateBrowserReconciliationState(
          transaction,
          claim,
          result.status,
          result.url,
        );
        if (browserPublications.length !== 1) throw stateInvalid();
        await insertBrowserReconcileEvent(
          transaction,
          event,
          claim,
          row,
          job.version,
          5,
          event.reconcileAttempt + 1,
          claim.platformCode,
        );
        await writeAudit(
          transaction,
          event,
          row.createdBy,
          'publish_job.reconciled',
          claim,
          { reconcile_attempt: event.reconcileAttempt, status: result.status },
          row.status,
        );
        return 'pending' as const;
      }
      if (result.status === 'published') {
        const updated = await transaction<{ version: number }[]>`
          UPDATE publish_jobs SET
            status='published', external_url=${result.url}, published_at=now(),
            last_error_json=NULL, version=version+1
          WHERE id=${claim.jobId}::uuid AND tenant_id=${claim.tenantId}::uuid
            AND status='publishing' AND version=${claim.jobVersion}
          RETURNING version
        `;
        const job = updated[0];
        if (!job) throw leaseLost();
        if (row.origin === 'baijiahao_automation') {
          await completeBaijiahaoAutomationRun(
            transaction,
            claim.tenantId,
            claim.jobId,
            'published',
            null,
          );
        } else if (isBrowserPlatformAutomationOrigin(row.origin)) {
          await completeBrowserPlatformAutomation(
            transaction,
            claim.tenantId,
            claim.jobId,
            'published',
            null,
          );
        }
        const browserPublications = await updateBrowserReconciliationState(
          transaction,
          claim,
          'published',
          result.url,
        );
        if (browserPublications.length !== 1) throw stateInvalid();
        if (row.origin === 'baijiahao_automation') {
          await completeBaijiahaoDailyBatchItem(
            transaction,
            claim.tenantId,
            claim.jobId,
            'published',
            null,
          );
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
        const delivery: Extract<PlatformDelivery, { readonly mode: 'api' }> = Object.freeze({
          externalId: result.externalId,
          mode: 'api',
          payloadHash: '',
          response: Object.freeze({ status: 'published' }),
          url: result.url,
        });
        await writeAudit(
          transaction,
          event,
          row.createdBy,
          'publish_job.published',
          claim,
          {
            external_id: result.externalId,
            reconcile_attempt: event.reconcileAttempt,
            status: 'published',
          },
          row.status,
        );
        await insertPublishedEvent(transaction, event, claim, row, delivery, job.version);
        return 'completed' as const;
      }
      const manualRequired = result.status !== 'failed';
      const errorPrefix = browserErrorPrefix(claim.platformCode);
      const platformName = browserPlatformName(claim.platformCode);
      const error = adapterError(
        result.status === 'processing'
          ? `${errorPrefix}_REVIEW_PENDING_TIMEOUT`
          : manualRequired
            ? `${errorPrefix}_STATUS_UNKNOWN`
            : `${errorPrefix}_REVIEW_FAILED`,
        result.status === 'processing'
          ? `${platformName} publication remained under review after twelve reconciliations.`
          : manualRequired
            ? `${platformName} publication status remained unknown after twelve reconciliations.`
            : `${platformName} rejected the submitted article.`,
      );
      const updated = await transaction<{ id: string }[]>`
        UPDATE publish_jobs SET
          status='failed', external_url=COALESCE(${result.url}, external_url),
          last_error_json=${JSON.stringify(error)}::text::jsonb, version=version+1
        WHERE id=${claim.jobId}::uuid AND tenant_id=${claim.tenantId}::uuid
          AND status='publishing' AND version=${claim.jobVersion}
        RETURNING id
      `;
      if (updated.length !== 1) throw leaseLost();
      if (row.origin === 'baijiahao_automation') {
        if (manualRequired) {
          const automation = await transaction<{ id: string }[]>`
            UPDATE baijiahao_automation_runs SET
              status='manual_required', last_error_json=${JSON.stringify(error)}::text::jsonb,
              finished_at=now(), version=version+1
            WHERE tenant_id=${claim.tenantId}::uuid AND publish_job_id=${claim.jobId}::uuid
              AND status='processing'
            RETURNING id
          `;
          if (automation.length !== 1) throw stateInvalid();
        } else {
          await completeBaijiahaoAutomationRun(
            transaction,
            claim.tenantId,
            claim.jobId,
            'publish_failed',
            error,
          );
        }
      } else if (isBrowserPlatformAutomationOrigin(row.origin)) {
        await completeBrowserPlatformAutomation(
          transaction,
          claim.tenantId,
          claim.jobId,
          manualRequired ? 'manual_required' : 'publish_failed',
          error,
        );
      }
      const browserPublications = await updateBrowserReconciliationTerminalFailure(
        transaction,
        claim,
        manualRequired ? 'manual_required' : 'failed',
        result.url,
        String(error['message']),
      );
      if (browserPublications.length !== 1) throw stateInvalid();
      if (row.origin === 'baijiahao_automation') {
        await completeBaijiahaoDailyBatchItem(
          transaction,
          claim.tenantId,
          claim.jobId,
          manualRequired ? 'manual_required' : 'publish_failed',
          error,
        );
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
        manualRequired ? 'publish_job.manual_required' : 'publish_job.failed',
        claim,
        {
          error_code: error['code'],
          reconcile_attempt: event.reconcileAttempt,
          status: manualRequired ? 'manual_required' : 'failed',
        },
        row.status,
      );
      return 'completed' as const;
    });
  }
}

function isLiejuOfficial(claim: PublishClaim): boolean {
  return claim.platformCode === 'lieju' && claim.liejuDeliveryMethod === 'official_api';
}

function updateLiejuOfficialPublication(
  transaction: postgres.TransactionSql,
  claim: PublishClaim,
  delivery: Extract<PlatformDelivery, { readonly mode: 'api' }>,
  status: 'processing' | 'published',
): Promise<{ id: string }[]> {
  const responseHash =
    typeof delivery.response['response_hash'] === 'string'
      ? delivery.response['response_hash']
      : null;
  const remoteReference = delivery.externalId.startsWith('api-') ? null : delivery.externalId;
  return transaction<{ id: string }[]>`
    UPDATE lieju_api_publications SET
      status=${status},remote_reference=${remoteReference},external_url=${delivery.url},
      response_hash=${responseHash},submitted_at=COALESCE(submitted_at,now()),
      last_error_json=NULL,version=version+1
    WHERE tenant_id=${claim.tenantId}::uuid AND publish_job_id=${claim.jobId}::uuid
      AND account_id=${claim.accountId}::uuid
      AND content_version_id=${claim.contentVersionId}::uuid
      AND status='reserved'
    RETURNING id
  `;
}

function updateLiejuOfficialPublicationFailure(
  transaction: postgres.TransactionSql,
  claim: PublishClaim,
  failure: {
    readonly code: string;
    readonly diagnostics?: Readonly<Record<string, unknown>>;
    readonly status: 'failed' | 'unknown';
  },
  error: Readonly<Record<string, unknown>>,
): Promise<void> {
  const status = failure.status === 'unknown' ? 'manual_required' : 'rejected';
  const responseHash = responseHashFromDiagnostics(failure.diagnostics);
  return transaction`
    UPDATE lieju_api_publications SET
      status=${status},last_error_json=${JSON.stringify(error)}::text::jsonb,
      response_hash=COALESCE(${responseHash},response_hash),
      submitted_at=CASE WHEN ${failure.status}='unknown' THEN COALESCE(submitted_at,now()) ELSE submitted_at END,
      version=version+1
    WHERE tenant_id=${claim.tenantId}::uuid AND publish_job_id=${claim.jobId}::uuid
      AND account_id=${claim.accountId}::uuid AND status='reserved'
  `.then(() => undefined);
}

function updateBrowserPublicationProcessing(
  transaction: postgres.TransactionSql,
  claim: PublishClaim,
  delivery: Extract<PlatformDelivery, { readonly mode: 'api' }>,
): Promise<{ id: string }[]> {
  if (claim.platformCode === 'sohu') {
    return transaction<{ id: string }[]>`
      UPDATE sohu_browser_publications SET
        status='processing',external_post_id=${delivery.externalId},
        external_url=COALESCE(${delivery.url},external_url),
        last_reconciled_at=now(),version=version+1
      WHERE tenant_id=${claim.tenantId}::uuid AND publish_job_id=${claim.jobId}::uuid
        AND account_id=${claim.accountId}::uuid
        AND content_version_id=${claim.contentVersionId}::uuid
        AND status IN ('submitting','unknown','processing')
      RETURNING id
    `;
  }
  if (claim.platformCode === 'lieju') {
    return transaction<{ id: string }[]>`
      UPDATE lieju_browser_publications SET
        status='processing',external_post_id=${delivery.externalId},
        external_url=COALESCE(${delivery.url},external_url),
        last_reconciled_at=now(),version=version+1
      WHERE tenant_id=${claim.tenantId}::uuid AND publish_job_id=${claim.jobId}::uuid
        AND account_id=${claim.accountId}::uuid
        AND content_version_id=${claim.contentVersionId}::uuid
        AND status IN ('submitting','unknown','processing')
      RETURNING id
    `;
  }
  return transaction<{ id: string }[]>`
    UPDATE baijiahao_browser_publications SET
      status='processing',external_post_id=${delivery.externalId},
      external_url=COALESCE(${delivery.url},external_url),
      last_reconciled_at=now(),version=version+1
    WHERE tenant_id=${claim.tenantId}::uuid AND publish_job_id=${claim.jobId}::uuid
      AND account_id=${claim.accountId}::uuid
      AND content_version_id=${claim.contentVersionId}::uuid
      AND status IN ('submitting','unknown','processing')
    RETURNING id
  `;
}

function selectPublishedBrowserPublication(
  transaction: postgres.TransactionSql,
  claim: PublishClaim,
  externalId: string,
): Promise<{ id: string }[]> {
  if (claim.platformCode === 'sohu') {
    return transaction<{ id: string }[]>`
      SELECT id FROM sohu_browser_publications
      WHERE tenant_id=${claim.tenantId}::uuid AND publish_job_id=${claim.jobId}::uuid
        AND account_id=${claim.accountId}::uuid
        AND content_version_id=${claim.contentVersionId}::uuid
        AND status='published' AND external_post_id=${externalId}
      FOR UPDATE
    `;
  }
  if (claim.platformCode === 'lieju') {
    return transaction<{ id: string }[]>`
      SELECT id FROM lieju_browser_publications
      WHERE tenant_id=${claim.tenantId}::uuid AND publish_job_id=${claim.jobId}::uuid
        AND account_id=${claim.accountId}::uuid
        AND content_version_id=${claim.contentVersionId}::uuid
        AND status='published' AND external_post_id=${externalId}
      FOR UPDATE
    `;
  }
  return transaction<{ id: string }[]>`
    SELECT id FROM baijiahao_browser_publications
    WHERE tenant_id=${claim.tenantId}::uuid AND publish_job_id=${claim.jobId}::uuid
      AND account_id=${claim.accountId}::uuid
      AND content_version_id=${claim.contentVersionId}::uuid
      AND status='published' AND external_post_id=${externalId}
    FOR UPDATE
  `;
}

function updateBrowserReconciliationState(
  transaction: postgres.TransactionSql,
  claim: BaijiahaoReconcileClaim,
  status: 'processing' | 'published' | 'unknown',
  url: string | null,
): Promise<{ id: string }[]> {
  if (claim.platformCode === 'sohu') {
    return transaction<{ id: string }[]>`
      UPDATE sohu_browser_publications SET
        status=${status}, external_url=COALESCE(${url}, external_url),
        last_reconciled_at=now(), version=version+1
      WHERE tenant_id=${claim.tenantId}::uuid AND publish_job_id=${claim.jobId}::uuid
        AND external_post_id=${claim.externalId}
        AND status IN ('submitting','unknown','processing','published')
      RETURNING id
    `;
  }
  if (claim.platformCode === 'lieju') {
    return transaction<{ id: string }[]>`
      UPDATE lieju_browser_publications SET
        status=${status}, external_url=COALESCE(${url}, external_url),
        last_reconciled_at=now(), version=version+1
      WHERE tenant_id=${claim.tenantId}::uuid AND publish_job_id=${claim.jobId}::uuid
        AND external_post_id=${claim.externalId}
        AND status IN ('submitting','unknown','processing','published')
      RETURNING id
    `;
  }
  return transaction<{ id: string }[]>`
    UPDATE baijiahao_browser_publications SET
      status=${status}, external_url=COALESCE(${url}, external_url),
      last_reconciled_at=now(), version=version+1
    WHERE tenant_id=${claim.tenantId}::uuid AND publish_job_id=${claim.jobId}::uuid
      AND external_post_id=${claim.externalId}
      AND status IN ('submitting','unknown','processing','published')
    RETURNING id
  `;
}

function updateBrowserReconciliationTerminalFailure(
  transaction: postgres.TransactionSql,
  claim: BaijiahaoReconcileClaim,
  status: 'failed' | 'manual_required',
  url: string | null,
  reason: string,
): Promise<{ id: string }[]> {
  if (claim.platformCode === 'sohu') {
    return transaction<{ id: string }[]>`
      UPDATE sohu_browser_publications SET
        status=${status}, external_url=COALESCE(${url}, external_url),
        review_reason=${reason}, last_reconciled_at=now(), version=version+1
      WHERE tenant_id=${claim.tenantId}::uuid AND publish_job_id=${claim.jobId}::uuid
        AND external_post_id=${claim.externalId}
        AND status IN ('submitting','unknown','processing','manual_required','failed')
      RETURNING id
    `;
  }
  if (claim.platformCode === 'lieju') {
    return transaction<{ id: string }[]>`
      UPDATE lieju_browser_publications SET
        status=${status}, external_url=COALESCE(${url}, external_url),
        review_reason=${reason}, last_reconciled_at=now(), version=version+1
      WHERE tenant_id=${claim.tenantId}::uuid AND publish_job_id=${claim.jobId}::uuid
        AND external_post_id=${claim.externalId}
        AND status IN ('submitting','unknown','processing','manual_required','failed')
      RETURNING id
    `;
  }
  return transaction<{ id: string }[]>`
    UPDATE baijiahao_browser_publications SET
      status=${status}, external_url=COALESCE(${url}, external_url),
      review_reason=${reason}, last_reconciled_at=now(), version=version+1
    WHERE tenant_id=${claim.tenantId}::uuid AND publish_job_id=${claim.jobId}::uuid
      AND external_post_id=${claim.externalId}
      AND status IN ('submitting','unknown','processing','manual_required','failed')
    RETURNING id
  `;
}

function updateBrowserPublicationFailure(
  transaction: postgres.TransactionSql,
  claim: PublishClaim,
  failure: { readonly message: string; readonly status: 'failed' | 'unknown' },
  error: Readonly<Record<string, unknown>>,
): Promise<void> {
  const status = failure.status === 'unknown' ? 'manual_required' : 'failed';
  if (claim.platformCode === 'lieju') {
    return transaction`
      UPDATE lieju_browser_publications SET
        status=${status},review_reason=${String(error['message'])},
        last_reconciled_at=now(),version=version+1
      WHERE tenant_id=${claim.tenantId}::uuid AND publish_job_id=${claim.jobId}::uuid
        AND status IN ('prepared','submitting','unknown','processing')
    `.then(() => undefined);
  }
  return transaction`
    UPDATE sohu_browser_publications SET
      status=${status},review_reason=${String(error['message'])},
      last_reconciled_at=now(),version=version+1
    WHERE tenant_id=${claim.tenantId}::uuid AND publish_job_id=${claim.jobId}::uuid
      AND status IN ('prepared','submitting','unknown','processing')
  `.then(() => undefined);
}

function selectBaijiahaoReconcileRow(
  transaction: postgres.TransactionSql,
  event: ValidatedBaijiahaoReconcileEvent,
  lock: boolean,
): Promise<BaijiahaoReconcileRow[]> {
  return transaction<BaijiahaoReconcileRow[]>`
    SELECT
      job.status, job.attempt_count AS "attemptCount", job.created_by AS "createdBy",
      job.origin, job.account_id AS "accountId", job.version AS "jobVersion",
      job.external_post_id AS "externalId", job.content_version_id AS "contentVersionId",
      variant.id AS "variantId", variant.status AS "variantStatus",
      variant.version AS "variantVersion", package.id AS "packageId",
      package.status AS "packageStatus", package.version AS "packageVersion",
      package.workspace_id AS "workspaceId", package.project_id AS "projectId",
      account.credential_ciphertext AS "credentialCiphertext",
      account.credential_key_version AS "credentialKeyVersion",
      account.publish_mode AS "publishMode", account.status AS "accountStatus",
      account.token_expires_at AS "accountTokenExpiresAt",
      account.deleted_at AS "accountDeletedAt"
    FROM publish_jobs AS job
    JOIN content_variants AS variant
      ON variant.id=job.variant_id AND variant.tenant_id=job.tenant_id
      AND variant.platform_code=${event.platformCode}
    JOIN content_packages AS package
      ON package.id=variant.package_id AND package.tenant_id=variant.tenant_id
    JOIN platform_accounts AS account
      ON account.id=job.account_id AND account.tenant_id=job.tenant_id
      AND account.workspace_id=package.workspace_id AND account.platform_code=${event.platformCode}
    WHERE job.id=${event.jobId}::uuid AND job.tenant_id=${event.tenantId}::uuid
      AND (
        (${event.platformCode}='baijiahao' AND job.origin IN ('manual','baijiahao_automation'))
        OR (${event.platformCode}='sohu' AND job.origin IN ('manual','sohu_automation'))
        OR (${event.platformCode}='lieju' AND job.origin IN ('manual','lieju_automation'))
      )
    ${lock ? transaction`FOR UPDATE OF job, variant, package, account` : transaction``}
  `;
}

async function lockCompletion(
  transaction: postgres.TransactionSql,
  event: ValidatedPublishEvent,
  claim: PublishClaim,
): Promise<CompletionRow> {
  const rows = await transaction<CompletionRow[]>`
    SELECT job.status, job.attempt_count AS "attemptCount", job.created_by AS "createdBy",
      job.origin, job.account_id AS "accountId",
      variant.id AS "variantId", variant.status AS "variantStatus",
      variant.version AS "variantVersion", package.id AS "packageId",
      package.status AS "packageStatus", package.version AS "packageVersion",
      package.workspace_id AS "workspaceId", package.project_id AS "projectId"
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
      ${adapterCode(claim.platformCode)}, ${value.status}, ${value.requestHash},
      ${JSON.stringify(response)}::text::jsonb, ${value.errorCode}, now(), now()
    )
  `;
}

function adapterCode(platformCode: PlatformCode): string {
  return platformCode === 'baijiahao'
    ? 'baijiahao-delivery@1.1.0'
    : `${platformCode}-delivery@1.0.0`;
}

function publishedAt(delivery: Extract<PlatformDelivery, { readonly mode: 'api' }>): Date {
  const value = delivery.response['published_at'];
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return new Date();
}

function deliveryStatus(
  delivery: Extract<PlatformDelivery, { readonly mode: 'api' }>,
): 'processing' | 'published' {
  return delivery.response['status'] === 'processing' ? 'processing' : 'published';
}

function isBrowserOrigin(
  origin: CompletionRow['origin'],
  platformCode: 'baijiahao' | 'lieju' | 'sohu',
): origin is 'manual' | 'baijiahao_automation' | 'sohu_automation' | 'lieju_automation' {
  return (
    origin === 'manual' ||
    (platformCode === 'baijiahao' && origin === 'baijiahao_automation') ||
    (platformCode === 'sohu' && origin === 'sohu_automation') ||
    (platformCode === 'lieju' && origin === 'lieju_automation')
  );
}

function isBrowserPlatformAutomationOrigin(
  origin: CompletionRow['origin'],
): origin is 'lieju_automation' | 'sohu_automation' {
  return origin === 'sohu_automation' || origin === 'lieju_automation';
}

function isBrowserPlatform(
  platformCode: PlatformCode,
): platformCode is 'baijiahao' | 'lieju' | 'sohu' {
  return platformCode === 'baijiahao' || platformCode === 'sohu' || platformCode === 'lieju';
}

function browserErrorPrefix(
  platformCode: 'baijiahao' | 'lieju' | 'sohu',
): 'BAIJIAHAO' | 'LIEJU' | 'SOHU' {
  return platformCode === 'sohu' ? 'SOHU' : platformCode === 'lieju' ? 'LIEJU' : 'BAIJIAHAO';
}

function browserPlatformName(
  platformCode: 'baijiahao' | 'lieju' | 'sohu',
): 'Baijiahao' | 'Lieju' | 'Sohu' {
  return platformCode === 'sohu' ? 'Sohu' : platformCode === 'lieju' ? 'Lieju' : 'Baijiahao';
}

function automatedReadyStatus(origin: CompletionRow['origin']): 'approved' | 'quality_passed' {
  return origin === 'manual' ? 'approved' : 'quality_passed';
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

async function completeBaijiahaoAutomationRun(
  transaction: postgres.TransactionSql,
  tenantId: string,
  publishJobId: string,
  status: 'disabled' | 'manual_required' | 'publish_failed' | 'published',
  error: Readonly<Record<string, unknown>> | null,
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    UPDATE baijiahao_automation_runs SET
      status=${status}, last_error_json=${error ? JSON.stringify(error) : null}::text::jsonb,
      finished_at=now(), version=version+1
    WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
      AND status IN ('scheduled','publishing','processing')
    RETURNING id
  `;
  if (rows.length !== 1) throw stateInvalid();
}

async function markBrowserPlatformAutomationProcessing(
  transaction: postgres.TransactionSql,
  tenantId: string,
  publishJobId: string,
) {
  const rows = await transaction<{ id: string }[]>`
    UPDATE browser_platform_automation_runs SET status='processing',last_error_json=NULL,
      finished_at=NULL,version=version+1
    WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
      AND status IN ('scheduled','publishing')
    RETURNING id
  `;
  if (rows.length !== 1) throw stateInvalid();
  await transaction`
    UPDATE browser_platform_daily_batch_items SET status='processing',last_error_json=NULL
    WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
      AND status='scheduled'
  `;
}

async function completeBrowserPlatformAutomation(
  transaction: postgres.TransactionSql,
  tenantId: string,
  publishJobId: string,
  status: 'disabled' | 'manual_required' | 'publish_failed' | 'published',
  error: Readonly<Record<string, unknown>> | null,
) {
  const rows = await transaction<{ id: string }[]>`
    UPDATE browser_platform_automation_runs SET status=${status},
      last_error_json=${error ? JSON.stringify(error) : null}::text::jsonb,
      finished_at=now(),version=version+1
    WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
      AND status IN ('scheduled','publishing','processing')
    RETURNING id
  `;
  if (rows.length !== 1) throw stateInvalid();
  const items = await transaction<{ batchId: string }[]>`
    UPDATE browser_platform_daily_batch_items SET status=${status === 'disabled' ? 'manual_required' : status},
      published_at=CASE WHEN ${status}='published' THEN now() ELSE NULL END,
      last_error_json=${error ? JSON.stringify(error) : null}::text::jsonb
    WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
      AND status IN ('scheduled','processing')
    RETURNING batch_id AS "batchId"
  `;
  const batchId = items[0]?.batchId;
  if (!batchId) return;
  if (status !== 'published') {
    await transaction`
      UPDATE browser_platform_daily_batches AS batch SET status='attention_required',
        last_error_json=${error ? JSON.stringify(error) : null}::text::jsonb,
        version=batch.version+1
      FROM browser_platform_daily_batches AS source
      WHERE source.id=${batchId}::uuid AND source.tenant_id=${tenantId}::uuid
        AND batch.tenant_id=source.tenant_id AND batch.policy_id=source.policy_id
        AND batch.business_date=source.business_date AND batch.status='scheduled'
        AND batch.attempt_no=(
          SELECT max(latest.attempt_no)
          FROM browser_platform_daily_batches AS latest
          WHERE latest.tenant_id=source.tenant_id AND latest.policy_id=source.policy_id
            AND latest.business_date=source.business_date
        )
    `;
    return;
  }
  await transaction`
    UPDATE browser_platform_daily_batches AS batch SET status='completed',completed_at=now(),
      last_error_json=NULL,version=batch.version+1
    FROM browser_platform_daily_batches AS source
    JOIN browser_platform_automation_policies AS policy
      ON policy.id=source.policy_id AND policy.tenant_id=source.tenant_id
    WHERE source.id=${batchId}::uuid AND source.tenant_id=${tenantId}::uuid
      AND batch.tenant_id=source.tenant_id AND batch.policy_id=source.policy_id
      AND batch.business_date=source.business_date AND batch.status IN ('scheduled','attention_required')
      AND batch.attempt_no=(
        SELECT max(latest.attempt_no)
        FROM browser_platform_daily_batches AS latest
        WHERE latest.tenant_id=source.tenant_id AND latest.policy_id=source.policy_id
          AND latest.business_date=source.business_date
      )
      AND (
        SELECT count(*) FROM browser_platform_daily_batches AS day_batch
        JOIN browser_platform_daily_batch_items AS item
          ON item.batch_id=day_batch.id AND item.tenant_id=day_batch.tenant_id
        WHERE day_batch.tenant_id=batch.tenant_id AND day_batch.policy_id=batch.policy_id
          AND day_batch.business_date=batch.business_date AND item.status='published'
      ) >= policy.daily_target_count
  `;
}

async function insertPublishedEvent(
  transaction: postgres.TransactionSql,
  event: Pick<ValidatedPublishEvent, 'requestId'>,
  claim: Pick<PublishClaim, 'contentVersionId' | 'jobId' | 'platformCode' | 'tenantId'>,
  row: CompletionRow,
  delivery: Extract<PlatformDelivery, { readonly mode: 'api' }>,
  jobVersion: number,
): Promise<void> {
  const eventId = randomUUID();
  const occurredAt = publishedAt(delivery).toISOString();
  const data = {
    account_id: row.accountId,
    content_version_id: claim.contentVersionId,
    created_by: row.createdBy,
    external_post_id: delivery.externalId,
    external_url: delivery.url,
    job_id: claim.jobId,
    job_version: jobVersion,
    origin: row.origin,
    package_id: row.packageId,
    platform_code: claim.platformCode,
    project_id: row.projectId,
    published_at: occurredAt,
    request_id: event.requestId,
    variant_id: row.variantId,
    workspace_id: row.workspaceId,
  };
  const envelope = {
    aggregate: { id: claim.jobId, type: 'publish_job' },
    data,
    event_id: eventId,
    event_type: 'publishing.job.published.v1',
    occurred_at: occurredAt,
    tenant: { id: claim.tenantId },
  };
  await transaction`
    INSERT INTO outbox_events (
      id, tenant_id, event_type, aggregate_type, aggregate_id, payload_json
    ) VALUES (
      ${eventId}::uuid, ${claim.tenantId}::uuid, 'publishing.job.published.v1',
      'publish_job', ${claim.jobId}::uuid, ${JSON.stringify(envelope)}::text::jsonb
    )
  `;
}

async function insertBrowserReconcileEvent(
  transaction: postgres.TransactionSql,
  event: Pick<ValidatedPublishEvent, 'requestId'>,
  claim: Pick<PublishClaim, 'jobId' | 'tenantId'>,
  row: CompletionRow,
  jobVersion: number,
  delayMinutes: number,
  reconcileAttempt = 1,
  platformCode: 'baijiahao' | 'lieju' | 'sohu' = 'baijiahao',
): Promise<void> {
  const eventId = randomUUID();
  const occurredAt = new Date().toISOString();
  const envelope = {
    aggregate: { id: claim.jobId, type: 'publish_job' },
    data: {
      account_id: row.accountId,
      external_post_id: null,
      job_id: claim.jobId,
      job_version: jobVersion,
      reconcile_attempt: reconcileAttempt,
      request_id: event.requestId,
    },
    event_id: eventId,
    event_type: `${platformCode}.publication.reconcile_requested.v1`,
    occurred_at: occurredAt,
    tenant: { id: claim.tenantId },
  };
  await transaction`
    INSERT INTO outbox_events (
      id, tenant_id, event_type, aggregate_type, aggregate_id,
      payload_json, next_attempt_at
    ) VALUES (
      ${eventId}::uuid, ${claim.tenantId}::uuid,
      ${`${platformCode}.publication.reconcile_requested.v1`}, 'publish_job',
      ${claim.jobId}::uuid, ${JSON.stringify(envelope)}::text::jsonb,
      now() + (${delayMinutes} * interval '1 minute')
    )
  `;
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
      status='completed',completed_at=now(),last_error_json=NULL,version=batch.version+1
    FROM official_site_daily_batches AS source
    JOIN official_site_automation_policies AS policy
      ON policy.id=source.policy_id AND policy.tenant_id=source.tenant_id
    WHERE source.id=${batchId}::uuid AND source.tenant_id=${tenantId}::uuid
      AND batch.tenant_id=source.tenant_id AND batch.policy_id=source.policy_id
      AND batch.business_date=source.business_date
      AND batch.status IN ('scheduled','attention_required')
      AND batch.attempt_no=(
        SELECT max(latest.attempt_no)
        FROM official_site_daily_batches AS latest
        WHERE latest.tenant_id=source.tenant_id AND latest.policy_id=source.policy_id
          AND latest.business_date=source.business_date
      )
      AND (
        SELECT count(*)
        FROM official_site_daily_batches AS day_batch
        JOIN official_site_daily_batch_items AS item
          ON item.batch_id=day_batch.id AND item.tenant_id=day_batch.tenant_id
        WHERE day_batch.tenant_id=batch.tenant_id AND day_batch.policy_id=batch.policy_id
          AND day_batch.business_date=batch.business_date AND item.status='published'
      ) >= policy.daily_target_count
  `;
}

async function completeBaijiahaoDailyBatchItem(
  transaction: postgres.TransactionSql,
  tenantId: string,
  publishJobId: string,
  status: 'manual_required' | 'publish_failed' | 'published',
  error: Readonly<Record<string, unknown>> | null,
): Promise<void> {
  const items = await transaction<{ batchId: string }[]>`
    UPDATE baijiahao_daily_batch_items SET
      status=${status},
      published_at=CASE WHEN ${status}='published' THEN now() ELSE NULL END,
      last_error_json=${error ? JSON.stringify(error) : null}::text::jsonb
    WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${publishJobId}::uuid
      AND status IN ('scheduled','processing')
    RETURNING batch_id AS "batchId"
  `;
  const batchId = items[0]?.batchId;
  if (!batchId) return;
  if (status !== 'published') {
    await transaction`
      UPDATE baijiahao_daily_batches AS batch SET
        status='attention_required',last_error_json=${JSON.stringify(error)}::text::jsonb,
        version=batch.version+1
      FROM baijiahao_daily_batches AS source
      WHERE source.id=${batchId}::uuid AND source.tenant_id=${tenantId}::uuid
        AND batch.tenant_id=source.tenant_id AND batch.policy_id=source.policy_id
        AND batch.business_date=source.business_date AND batch.status='scheduled'
        AND batch.attempt_no=(
          SELECT max(latest.attempt_no)
          FROM baijiahao_daily_batches AS latest
          WHERE latest.tenant_id=source.tenant_id AND latest.policy_id=source.policy_id
            AND latest.business_date=source.business_date
        )
    `;
    return;
  }
  await transaction`
    UPDATE baijiahao_daily_batches AS batch SET
      status='completed', completed_at=now(), last_error_json=NULL, version=batch.version+1
    FROM baijiahao_daily_batches AS source
    JOIN baijiahao_automation_policies AS policy
      ON policy.id=source.policy_id AND policy.tenant_id=source.tenant_id
    WHERE source.id=${batchId}::uuid AND source.tenant_id=${tenantId}::uuid
      AND batch.tenant_id=source.tenant_id AND batch.policy_id=source.policy_id
      AND batch.business_date=source.business_date AND batch.status IN ('scheduled','attention_required')
      AND batch.attempt_no=(
        SELECT max(latest.attempt_no)
        FROM baijiahao_daily_batches AS latest
        WHERE latest.tenant_id=source.tenant_id AND latest.policy_id=source.policy_id
          AND latest.business_date=source.business_date
      )
      AND (
        SELECT count(*) FROM baijiahao_daily_batches AS day_batch
        JOIN baijiahao_daily_batch_items AS item
          ON item.batch_id=day_batch.id AND item.tenant_id=day_batch.tenant_id
        WHERE day_batch.tenant_id=batch.tenant_id AND day_batch.policy_id=batch.policy_id
          AND day_batch.business_date=batch.business_date AND item.status='published'
      ) >= policy.daily_target_count
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
    UPDATE official_site_daily_batches AS batch SET
      status='attention_required',
      last_error_json=${JSON.stringify({
        code: 'DAILY_PUBLISH_FAILED',
        message: '官网发布重试 3 次后仍失败，请检查官网连接。',
        schema_version: 'official-site-daily-error@1',
      })}::text::jsonb,
      version=batch.version+1
    FROM official_site_daily_batches AS source
    WHERE source.id=${batchId}::uuid AND source.tenant_id=${tenantId}::uuid
      AND batch.tenant_id=source.tenant_id AND batch.policy_id=source.policy_id
      AND batch.business_date=source.business_date AND batch.status='scheduled'
      AND batch.attempt_no=(
        SELECT max(latest.attempt_no)
        FROM official_site_daily_batches AS latest
        WHERE latest.tenant_id=source.tenant_id AND latest.policy_id=source.policy_id
          AND latest.business_date=source.business_date
      )
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
  event: Pick<ValidatedPublishEvent, 'requestId'>,
  actorId: string,
  action: string,
  claim: Pick<PublishClaim, 'attempt' | 'jobId' | 'tenantId'>,
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

function adapterError(
  code: string,
  message: string,
  diagnostics?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    code,
    ...(diagnostics ? { diagnostics: redactSensitiveData(diagnostics) } : {}),
    message: message.slice(0, 2_000),
    schema_version: 'adapter-error@1',
  });
}

function responseHashFromDiagnostics(
  diagnostics: Readonly<Record<string, unknown>> | undefined,
): string | null {
  const value = diagnostics?.['response_sha256'];
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) ? value : null;
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
