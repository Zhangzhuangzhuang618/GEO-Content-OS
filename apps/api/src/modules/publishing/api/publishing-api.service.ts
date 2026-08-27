import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import type {
  ContentDocument,
  ContentVariantStatus,
  ExportArtifactView,
  PlatformCode,
  PublishAttemptView,
  PublishJobDetail,
  PublishJobQuery,
  PublishJobView,
  PublishMediaRun,
  PublishMediaState,
  SignedDownloadView,
} from '@geo-content-os/contracts';
import { ContentDocumentSchema, PublishJobParamsSchema } from '@geo-content-os/contracts';
import type postgres from 'postgres';

import { resolveDatabaseClient, type DatabaseClientSource } from '../../../database/index.js';
import { OutboxWriter } from '../../outbox/index.js';
import { assessUnknownPublishResolution } from '../jobs/publish-job-unknown-resolution.js';
import { PublishingApiError } from './publishing-api.errors.js';

export interface PublishingApiScope {
  readonly tenantId: string;
  readonly userId: string;
}

type DatabaseDate = Date | string;

interface JobRow {
  readonly accountId: string;
  readonly attemptCount: number;
  readonly contentVersionId: string;
  readonly createdAt: DatabaseDate;
  readonly createdBy: string;
  readonly externalPostId: string | null;
  readonly externalUrl: string | null;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly lastError: Readonly<Record<string, unknown>> | null;
  readonly liejuDeliveryMethod: string | null;
  readonly origin: PublishJobView['origin'];
  readonly payloadHash: string;
  readonly platformCode: PlatformCode;
  readonly publishedAt: DatabaseDate | null;
  readonly scheduledAt: DatabaseDate;
  readonly status: PublishJobView['status'];
  readonly tenantId: string;
  readonly updatedAt: DatabaseDate;
  readonly variantId: string;
  readonly variantCurrentContentVersionId: string | null;
  readonly variantStatus: ContentVariantStatus;
  readonly version: number;
}

interface AttemptRow {
  readonly adapterCode: string;
  readonly attemptNo: number;
  readonly createdAt: DatabaseDate;
  readonly errorCode: string | null;
  readonly finishedAt: DatabaseDate | null;
  readonly id: string;
  readonly publishJobId: string;
  readonly requestHash: string;
  readonly response: Readonly<Record<string, unknown>> | null;
  readonly startedAt: DatabaseDate;
  readonly status: PublishAttemptView['status'];
  readonly tenantId: string;
}

interface ArtifactRow {
  readonly contentHash: string;
  readonly contentVersionId: string;
  readonly createdAt: DatabaseDate;
  readonly createdBy: string;
  readonly expiresAt: DatabaseDate;
  readonly id: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly objectUri: string;
  readonly publishJobId: string | null;
  readonly tenantId: string;
  readonly variantId: string;
}

interface PublishMediaConfig {
  readonly enabled: boolean;
  readonly generationModel: string | null;
  readonly inspectionModel: string | null;
  readonly plannerModelKey: string;
  readonly provider: 'cloudflare' | null;
}

interface MediaStateRow {
  readonly assetCount: number;
  readonly platformCode: string;
  readonly runId: string | null;
  readonly runStatus: 'queued' | 'running' | 'succeeded' | 'fallback' | 'cancelled' | null;
}

interface MediaRequestRow {
  readonly assetCount: number;
  readonly contentHash: string;
  readonly contentVersionId: string;
  readonly currentContentVersionId: string | null;
  readonly packageId: string;
  readonly platformCode: string;
  readonly projectId: string;
  readonly qualityReportId: string | null;
  readonly qualityReportPassed: boolean;
  readonly status: PublishJobView['status'];
  readonly variantId: string;
  readonly version: number;
  readonly workspaceId: string;
}

interface ContentSnapshotRow {
  readonly content: unknown;
  readonly contentHash: string;
  readonly contentVersionId: string;
}

export class PublishingApiService {
  private readonly outbox: OutboxWriter;

  public constructor(
    private readonly databaseSource: DatabaseClientSource,
    private readonly storage: ObjectStorageAdapter,
    outbox?: OutboxWriter,
    private readonly mediaConfig: PublishMediaConfig = readPublishMediaConfig(),
  ) {
    this.outbox = outbox ?? new OutboxWriter(resolveDatabaseClient(databaseSource));
  }

  private get database() {
    return resolveDatabaseClient(this.databaseSource);
  }

  public async listJobs(
    scope: PublishingApiScope,
    query: PublishJobQuery,
  ): Promise<{ readonly items: readonly PublishJobView[]; readonly nextCursor: string | null }> {
    const cursor = decodeCursor(query.cursor);
    const rows = await this.database<JobRow[]>`
      SELECT
        job.id, job.tenant_id AS "tenantId", job.variant_id AS "variantId",
        job.content_version_id AS "contentVersionId", job.account_id AS "accountId",
        job.scheduled_at AS "scheduledAt", job.idempotency_key AS "idempotencyKey",
        job.payload_hash AS "payloadHash", job.status,
        job.attempt_count AS "attemptCount", job.external_post_id AS "externalPostId",
        job.external_url AS "externalUrl", job.last_error_json AS "lastError", job.origin,
        job.published_at AS "publishedAt", variant.platform_code AS "platformCode",
        variant.status AS "variantStatus",
        variant.current_content_version_id AS "variantCurrentContentVersionId",
        account.capabilities_json->>'delivery_method' AS "liejuDeliveryMethod",
        job.created_by AS "createdBy", job.created_at AS "createdAt",
        job.updated_at AS "updatedAt", job.version
      FROM publish_jobs AS job
      JOIN content_variants AS variant
        ON variant.id=job.variant_id AND variant.tenant_id=job.tenant_id
      JOIN content_packages AS package
        ON package.id=variant.package_id AND package.tenant_id=variant.tenant_id
      JOIN platform_accounts AS account
        ON account.id=job.account_id AND account.tenant_id=job.tenant_id
      WHERE job.tenant_id=${scope.tenantId}::uuid
        AND (${query.workspace_id ?? null}::uuid IS NULL OR package.workspace_id=${query.workspace_id ?? null}::uuid)
        AND (${query.platform_code ?? null}::varchar IS NULL OR variant.platform_code=${query.platform_code ?? null})
        AND (${query.account_id ?? null}::uuid IS NULL OR job.account_id=${query.account_id ?? null}::uuid)
        AND (${query.variant_id ?? null}::uuid IS NULL OR job.variant_id=${query.variant_id ?? null}::uuid)
        AND (${query.status ?? null}::varchar IS NULL OR job.status=${query.status ?? null})
        AND (${query.from ?? null}::timestamptz IS NULL OR job.scheduled_at>=${query.from ?? null}::timestamptz)
        AND (${query.to ?? null}::timestamptz IS NULL OR job.scheduled_at<${query.to ?? null}::timestamptz)
        AND (
          ${cursor?.scheduledAt ?? null}::timestamptz IS NULL
          OR (job.scheduled_at,job.id)<(${cursor?.scheduledAt ?? null}::timestamptz,${cursor?.id ?? null}::uuid)
        )
        AND has_project_scope_access(
          package.tenant_id,package.workspace_id,package.project_id,${scope.userId}::uuid
        )
      ORDER BY job.scheduled_at DESC,job.id DESC
      LIMIT ${query.limit + 1}
    `;
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: Object.freeze(page.map(mapJob)),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ id: last.id, scheduledAt: isoDate(last.scheduledAt) })
          : null,
    };
  }

  public async detail(scope: PublishingApiScope, jobId: string): Promise<PublishJobDetail> {
    const job = await this.requireJob(scope, jobId);
    const [attempts, artifact, media, baijiahaoReconciliation, contentSnapshot] = await Promise.all(
      [
        this.attemptRows(scope, jobId),
        this.latestArtifact(scope, jobId),
        this.mediaState(scope, jobId),
        this.baijiahaoReconciliation(scope, job),
        this.contentSnapshot(scope, job),
      ],
    );
    return {
      attempts: attempts.map(mapAttempt),
      baijiahao_reconciliation: baijiahaoReconciliation,
      content_snapshot: contentSnapshot,
      export_artifact: artifact ? mapArtifact(artifact) : null,
      job: mapJob(job),
      media,
      unknown_resolution: unknownResolution(job, attempts),
    };
  }

  private async contentSnapshot(
    scope: PublishingApiScope,
    job: JobRow,
  ): Promise<{
    readonly content: ContentDocument;
    readonly content_hash: string;
    readonly content_version_id: string;
  }> {
    const rows = await this.database<ContentSnapshotRow[]>`
      SELECT
        version.id AS "contentVersionId",version.content_hash AS "contentHash",
        version.content_json AS content
      FROM content_versions AS version
      JOIN content_variants AS variant
        ON variant.id=${job.variantId}::uuid AND variant.tenant_id=version.tenant_id
        AND version.variant_id=variant.id AND version.package_id=variant.package_id
      JOIN content_packages AS package
        ON package.id=variant.package_id AND package.tenant_id=variant.tenant_id
      WHERE version.tenant_id=${scope.tenantId}::uuid
        AND version.id=${job.contentVersionId}::uuid
        AND has_project_scope_access(
          package.tenant_id,package.workspace_id,package.project_id,${scope.userId}::uuid
        )
      LIMIT 1
    `;
    const row = rows[0];
    const parsed = ContentDocumentSchema.safeParse(row?.content);
    if (
      !row ||
      row.contentVersionId !== job.contentVersionId ||
      row.contentHash !== job.payloadHash ||
      !parsed.success
    ) {
      throw new PublishingApiError(
        'PUBLISHING_STATE_INVALID',
        'Publish job content snapshot is unavailable or inconsistent',
      );
    }
    return Object.freeze({
      content: parsed.data,
      content_hash: row.contentHash,
      content_version_id: row.contentVersionId,
    });
  }

  private async baijiahaoReconciliation(
    scope: PublishingApiScope,
    job: JobRow,
  ): Promise<{ readonly platform_code: 'baijiahao' | 'douyin' | 'lieju' | 'sohu' } | null> {
    if (
      !isBrowserPlatform(job.platformCode) ||
      job.status !== 'publishing' ||
      !job.externalPostId
    ) {
      return null;
    }
    const rows = await browserPublicationRows(
      this.database,
      scope.tenantId,
      job.id,
      job.platformCode,
    );
    const publication = rows[0];
    if (
      rows.length !== 1 ||
      publication?.externalPostId !== job.externalPostId ||
      (publication.status !== 'published' && publication.status !== 'failed')
    ) {
      return null;
    }
    return Object.freeze({ platform_code: job.platformCode });
  }

  public requestMedia(
    transaction: postgres.TransactionSql,
    scope: PublishingApiScope,
    jobId: string,
    expectedVersion: number,
    requestId: string,
  ): Promise<PublishMediaRun> {
    return this.requestMediaInTransaction(transaction, scope, jobId, expectedVersion, requestId);
  }

  public async attempts(
    scope: PublishingApiScope,
    jobId: string,
  ): Promise<readonly PublishAttemptView[]> {
    await this.requireJob(scope, jobId);
    return Object.freeze((await this.attemptRows(scope, jobId)).map(mapAttempt));
  }

  public async signedExport(scope: PublishingApiScope, jobId: string): Promise<SignedDownloadView> {
    await this.requireJob(scope, jobId);
    const artifact = await this.latestArtifact(scope, jobId);
    if (!artifact || asDate(artifact.expiresAt) <= new Date()) {
      throw new PublishingApiError(
        'PUBLISHING_ARTIFACT_UNAVAILABLE',
        'Publish export artifact is unavailable',
      );
    }
    const seconds = Math.max(
      1,
      Math.min(900, Math.floor((asDate(artifact.expiresAt).getTime() - Date.now()) / 1_000)),
    );
    try {
      return {
        artifact_id: artifact.id,
        content_hash: artifact.contentHash,
        content_version_id: artifact.contentVersionId,
        expires_at: new Date(Date.now() + seconds * 1_000).toISOString(),
        url: await this.storage.createDownloadUrl(objectKey(artifact.objectUri), seconds),
      };
    } catch (error) {
      if (error instanceof PublishingApiError) throw error;
      throw new PublishingApiError(
        'PUBLISHING_ARTIFACT_UNAVAILABLE',
        'Publish export artifact download is unavailable',
      );
    }
  }

  private async requireJob(scope: PublishingApiScope, jobId: string): Promise<JobRow> {
    const rows = await this.database<JobRow[]>`
      SELECT
        job.id,job.tenant_id AS "tenantId",job.variant_id AS "variantId",
        job.content_version_id AS "contentVersionId",job.account_id AS "accountId",
        job.scheduled_at AS "scheduledAt",job.idempotency_key AS "idempotencyKey",
        job.payload_hash AS "payloadHash",job.status,job.attempt_count AS "attemptCount",
        job.external_post_id AS "externalPostId",job.external_url AS "externalUrl",
        job.last_error_json AS "lastError",job.origin,job.published_at AS "publishedAt",
        job.created_by AS "createdBy",variant.platform_code AS "platformCode",
        variant.status AS "variantStatus",
        variant.current_content_version_id AS "variantCurrentContentVersionId",
        account.capabilities_json->>'delivery_method' AS "liejuDeliveryMethod",
        job.created_at AS "createdAt",job.updated_at AS "updatedAt",job.version
      FROM publish_jobs AS job
      JOIN content_variants AS variant ON variant.id=job.variant_id AND variant.tenant_id=job.tenant_id
      JOIN content_packages AS package ON package.id=variant.package_id AND package.tenant_id=variant.tenant_id
      JOIN platform_accounts AS account ON account.id=job.account_id AND account.tenant_id=job.tenant_id
      WHERE job.id=${jobId}::uuid AND job.tenant_id=${scope.tenantId}::uuid
        AND has_project_scope_access(package.tenant_id,package.workspace_id,package.project_id,${scope.userId}::uuid)
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw new PublishingApiError('PUBLISHING_NOT_FOUND', 'Publish job was not found');
    return row;
  }

  private attemptRows(scope: PublishingApiScope, jobId: string): Promise<AttemptRow[]> {
    return this.database<AttemptRow[]>`
      SELECT id,tenant_id AS "tenantId",publish_job_id AS "publishJobId",
        attempt_no AS "attemptNo",adapter_code AS "adapterCode",status,
        request_hash AS "requestHash",response_json AS response,error_code AS "errorCode",
        started_at AS "startedAt",finished_at AS "finishedAt",created_at AS "createdAt"
      FROM publish_attempts
      WHERE tenant_id=${scope.tenantId}::uuid AND publish_job_id=${jobId}::uuid
      ORDER BY attempt_no,id
    `;
  }

  private async latestArtifact(
    scope: PublishingApiScope,
    jobId: string,
  ): Promise<ArtifactRow | undefined> {
    const rows = await this.database<ArtifactRow[]>`
      SELECT id,tenant_id AS "tenantId",variant_id AS "variantId",
        content_version_id AS "contentVersionId",publish_job_id AS "publishJobId",
        object_uri AS "objectUri",manifest_json AS manifest,content_hash AS "contentHash",
        expires_at AS "expiresAt",created_by AS "createdBy",created_at AS "createdAt"
      FROM export_artifacts
      WHERE tenant_id=${scope.tenantId}::uuid AND publish_job_id=${jobId}::uuid
      ORDER BY created_at DESC,id DESC LIMIT 1
    `;
    return rows[0];
  }

  private async mediaState(scope: PublishingApiScope, jobId: string): Promise<PublishMediaState> {
    const rows = await this.database<MediaStateRow[]>`
      SELECT variant.platform_code AS "platformCode",
        COALESCE((
          SELECT count(*)::integer FROM content_media_assets AS link
          JOIN media_assets AS asset
            ON asset.id=link.media_asset_id AND asset.tenant_id=link.tenant_id
            AND asset.asset_type='image' AND asset.deleted_at IS NULL
          WHERE link.tenant_id=job.tenant_id
            AND link.content_version_id=job.content_version_id
            AND link.quality_json->>'decision'='pass'
        ),0)::integer AS "assetCount",
        media.id AS "runId",media.status AS "runStatus"
      FROM publish_jobs AS job
      JOIN content_variants AS variant
        ON variant.id=job.variant_id AND variant.tenant_id=job.tenant_id
      JOIN content_packages AS package
        ON package.id=variant.package_id AND package.tenant_id=variant.tenant_id
      LEFT JOIN LATERAL (
        SELECT id,status FROM content_media_runs
        WHERE tenant_id=job.tenant_id AND variant_id=job.variant_id
          AND content_version_id=job.content_version_id
        ORDER BY created_at DESC,id DESC LIMIT 1
      ) AS media ON true
      WHERE job.id=${jobId}::uuid AND job.tenant_id=${scope.tenantId}::uuid
        AND has_project_scope_access(
          package.tenant_id,package.workspace_id,package.project_id,${scope.userId}::uuid
        )
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw new PublishingApiError('PUBLISHING_NOT_FOUND', 'Publish job was not found');
    const supported =
      isMediaPlatform(row.platformCode) &&
      (row.platformCode === 'douyin' || this.mediaConfig.enabled);
    const status =
      row.assetCount > 0
        ? 'ready'
        : row.runStatus === 'queued' || row.runStatus === 'running'
          ? row.runStatus
          : 'none';
    return Object.freeze({
      asset_count: row.assetCount,
      run_id: row.runId,
      status,
      supported,
    });
  }

  private async requestMediaInTransaction(
    transaction: postgres.TransactionSql,
    scope: PublishingApiScope,
    jobId: string,
    expectedVersion: number,
    requestId: string,
  ): Promise<PublishMediaRun> {
    const rows = await transaction<MediaRequestRow[]>`
      SELECT job.status,job.version,job.variant_id AS "variantId",
        job.content_version_id AS "contentVersionId",variant.platform_code AS "platformCode",
        variant.current_content_version_id AS "currentContentVersionId",
        package.id AS "packageId",package.workspace_id AS "workspaceId",
        package.project_id AS "projectId",content.content_hash AS "contentHash",
        report.id AS "qualityReportId",
        COALESCE((
          report.decision='pass'
          AND (report.automation_gate_json IS NULL OR report.automation_gate_json->>'passed'='true')
        ),false) AS "qualityReportPassed",
        COALESCE((
          SELECT count(*)::integer FROM content_media_assets AS link
          JOIN media_assets AS asset
            ON asset.id=link.media_asset_id AND asset.tenant_id=link.tenant_id
            AND asset.asset_type='image' AND asset.deleted_at IS NULL
          WHERE link.tenant_id=job.tenant_id
            AND link.content_version_id=job.content_version_id
            AND link.quality_json->>'decision'='pass'
        ),0)::integer AS "assetCount"
      FROM publish_jobs AS job
      JOIN content_variants AS variant
        ON variant.id=job.variant_id AND variant.tenant_id=job.tenant_id
      JOIN content_packages AS package
        ON package.id=variant.package_id AND package.tenant_id=variant.tenant_id
      JOIN content_versions AS content
        ON content.id=job.content_version_id AND content.tenant_id=job.tenant_id
        AND content.package_id=package.id AND content.variant_id=variant.id
      LEFT JOIN LATERAL (
        SELECT id,decision,automation_gate_json FROM quality_reports
        WHERE tenant_id=job.tenant_id AND variant_id=job.variant_id
          AND content_version_id=job.content_version_id
        ORDER BY created_at DESC,id DESC LIMIT 1
      ) AS report ON true
      WHERE job.id=${jobId}::uuid AND job.tenant_id=${scope.tenantId}::uuid
        AND has_project_scope_access(
          package.tenant_id,package.workspace_id,package.project_id,${scope.userId}::uuid
        )
      LIMIT 1
      FOR UPDATE OF job
    `;
    const row = rows[0];
    if (!row) throw new PublishingApiError('PUBLISHING_NOT_FOUND', 'Publish job was not found');
    if (row.version !== expectedVersion) {
      throw new PublishingApiError('PUBLISHING_STATE_INVALID', 'Publish job version changed');
    }
    if (!this.mediaConfig.enabled && row.platformCode !== 'douyin') {
      throw new PublishingApiError('PUBLISHING_STATE_INVALID', 'Image generation is disabled');
    }
    if (row.status !== 'scheduled') {
      throw new PublishingApiError(
        'PUBLISHING_STATE_INVALID',
        'Only scheduled publish jobs can generate images',
      );
    }
    if (!isMediaPlatform(row.platformCode)) {
      throw new PublishingApiError(
        'PUBLISHING_STATE_INVALID',
        'The target publisher cannot attach generated images',
      );
    }
    if (
      row.currentContentVersionId !== row.contentVersionId ||
      !row.qualityReportId ||
      !row.qualityReportPassed
    ) {
      throw new PublishingApiError(
        'PUBLISHING_STATE_INVALID',
        'The scheduled content does not have a passing current quality report',
      );
    }
    if (row.assetCount > 0) {
      throw new PublishingApiError(
        'PUBLISHING_STATE_INVALID',
        'The scheduled content already has generated images',
      );
    }

    const existing = await transaction<
      { id: string; status: 'queued' | 'running' | 'succeeded' | 'fallback' | 'cancelled' }[]
    >`
      SELECT id,status FROM content_media_runs
      WHERE tenant_id=${scope.tenantId}::uuid AND quality_report_id=${row.qualityReportId}::uuid
      FOR UPDATE
    `;
    const active = existing[0];
    if (active?.status === 'queued' || active?.status === 'running') {
      return Object.freeze({ id: active.id, status: active.status });
    }
    const mediaRuns = active
      ? await transaction<{ id: string; status: 'queued' }[]>`
          UPDATE content_media_runs SET status='queued',planner_model_key=${this.mediaConfig.plannerModelKey},
            provider=${this.mediaConfig.provider},generation_model=${this.mediaConfig.generationModel},
            inspection_model=${this.mediaConfig.inspectionModel},plan_json=NULL,
            diagnostics_json='{}'::jsonb,last_error_json=NULL,created_by=${scope.userId}::uuid,
            started_at=NULL,finished_at=NULL,version=version+1
          WHERE id=${active.id}::uuid AND tenant_id=${scope.tenantId}::uuid
          RETURNING id,status
        `
      : await transaction<{ id: string; status: 'queued' }[]>`
          INSERT INTO content_media_runs (
            tenant_id,workspace_id,project_id,package_id,variant_id,content_version_id,
            quality_report_id,platform_code,planner_model_key,provider,generation_model,
            inspection_model,created_by
          ) VALUES (
            ${scope.tenantId}::uuid,${row.workspaceId}::uuid,${row.projectId}::uuid,
            ${row.packageId}::uuid,${row.variantId}::uuid,${row.contentVersionId}::uuid,
            ${row.qualityReportId}::uuid,${row.platformCode},${this.mediaConfig.plannerModelKey},
            ${this.mediaConfig.provider},${this.mediaConfig.generationModel},
            ${this.mediaConfig.inspectionModel},${scope.userId}::uuid
          ) RETURNING id,status
        `;
    const mediaRun = mediaRuns[0];
    if (!mediaRun) {
      throw new PublishingApiError('PUBLISHING_STATE_INVALID', 'Image generation was not queued');
    }
    await this.outbox.enqueue(
      {
        aggregateId: mediaRun.id,
        aggregateType: 'content_media_run',
        data: {
          actor_user_id: scope.userId,
          content_hash: row.contentHash,
          content_version_id: row.contentVersionId,
          media_run_id: mediaRun.id,
          package_id: row.packageId,
          platform_code: row.platformCode,
          project_id: row.projectId,
          publish_job_id: jobId,
          quality_report_id: row.qualityReportId,
          request_id: boundedRequestId(`publish-media-${requestId}`),
          variant_id: row.variantId,
          workspace_id: row.workspaceId,
        },
        eventType: 'content.variant.media_generation_requested.v1',
        tenantId: scope.tenantId,
      },
      transaction,
    );
    await transaction`
      INSERT INTO audit_events (
        tenant_id,actor_id,action,resource_type,resource_id,before_json,after_json,request_id
      ) VALUES (
        ${scope.tenantId}::uuid,${scope.userId}::uuid,'publish_job.media_requested',
        'publish_job',${jobId}::uuid,NULL,
        ${JSON.stringify({ content_version_id: row.contentVersionId, media_run_id: mediaRun.id })}::text::jsonb,
        ${requestId}
      )
    `;
    return Object.freeze(mediaRun);
  }
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

function unknownResolution(
  job: JobRow,
  attempts: readonly AttemptRow[],
): PublishJobDetail['unknown_resolution'] {
  const latest = attempts.at(-1);
  if (!isBrowserPlatform(job.platformCode)) return null;
  const assessment = assessUnknownPublishResolution({
    contentVersionId: job.contentVersionId,
    jobStatus: job.status,
    latestAttempt: latest,
    liejuOfficial: job.liejuDeliveryMethod === 'official_api',
    platformCode: job.platformCode,
    variantCurrentContentVersionId: job.variantCurrentContentVersionId,
    variantStatus: job.variantStatus,
  });
  if (!assessment || !latest) return null;
  return {
    blocked_reason: assessment.blockedReason,
    can_retry:
      assessment.blockedReason === null && job.attemptCount < (job.origin === 'manual' ? 20 : 3),
    latest_attempt_no: latest.attemptNo,
    platform_code: job.platformCode,
  };
}

function mapAttempt(row: AttemptRow): PublishAttemptView {
  return {
    adapter_code: row.adapterCode,
    attempt_no: row.attemptNo,
    created_at: isoDate(row.createdAt),
    error_code: row.errorCode,
    finished_at: row.finishedAt ? isoDate(row.finishedAt) : null,
    id: row.id,
    publish_job_id: row.publishJobId,
    request_hash: row.requestHash,
    response: row.response,
    started_at: isoDate(row.startedAt),
    status: row.status,
    tenant_id: row.tenantId,
  };
}

function mapArtifact(row: ArtifactRow): ExportArtifactView {
  return {
    content_hash: row.contentHash,
    content_version_id: row.contentVersionId,
    created_at: isoDate(row.createdAt),
    created_by: row.createdBy,
    expires_at: isoDate(row.expiresAt),
    id: row.id,
    manifest: row.manifest,
    publish_job_id: row.publishJobId,
    tenant_id: row.tenantId,
    variant_id: row.variantId,
  };
}

function asDate(value: DatabaseDate): Date {
  return value instanceof Date ? value : new Date(value);
}

function isoDate(value: DatabaseDate): string {
  return asDate(value).toISOString();
}

function encodeCursor(value: { readonly id: string; readonly scheduledAt: string }): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(
  value: string | undefined,
): { readonly id: string; readonly scheduledAt: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      !isRecord(parsed) ||
      typeof parsed['id'] !== 'string' ||
      typeof parsed['scheduledAt'] !== 'string'
    )
      throw new Error();
    if (
      !PublishJobParamsSchema.safeParse({ id: parsed['id'] }).success ||
      !Number.isFinite(new Date(parsed['scheduledAt']).getTime())
    )
      throw new Error();
    return { id: parsed['id'], scheduledAt: parsed['scheduledAt'] };
  } catch {
    throw new PublishingApiError('PUBLISHING_INPUT_INVALID', 'Publish job cursor is invalid');
  }
}

function objectKey(uri: string): string {
  const parsed = new URL(uri);
  if (parsed.protocol !== 's3:' && parsed.protocol !== 'memory:') {
    throw new PublishingApiError(
      'PUBLISHING_ARTIFACT_UNAVAILABLE',
      'Publish export artifact location is invalid',
    );
  }
  const key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!key)
    throw new PublishingApiError(
      'PUBLISHING_ARTIFACT_UNAVAILABLE',
      'Publish export artifact location is invalid',
    );
  return key;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function browserPublicationRows(
  database: postgres.Sql,
  tenantId: string,
  jobId: string,
  platformCode: 'baijiahao' | 'douyin' | 'lieju' | 'sohu',
): Promise<{ externalPostId: string | null; status: string }[]> {
  if (platformCode === 'douyin') {
    return database<{ externalPostId: string | null; status: string }[]>`
      SELECT external_post_id AS "externalPostId",status
      FROM douyin_browser_publications
      WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${jobId}::uuid
      LIMIT 2
    `;
  }
  if (platformCode === 'sohu') {
    return database<{ externalPostId: string | null; status: string }[]>`
      SELECT external_post_id AS "externalPostId",status
      FROM sohu_browser_publications
      WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${jobId}::uuid
      LIMIT 2
    `;
  }
  if (platformCode === 'lieju') {
    return database<{ externalPostId: string | null; status: string }[]>`
      SELECT external_post_id AS "externalPostId",status
      FROM lieju_browser_publications
      WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${jobId}::uuid
      LIMIT 2
    `;
  }
  return database<{ externalPostId: string | null; status: string }[]>`
    SELECT external_post_id AS "externalPostId",status
    FROM baijiahao_browser_publications
    WHERE tenant_id=${tenantId}::uuid AND publish_job_id=${jobId}::uuid
    LIMIT 2
  `;
}

function readPublishMediaConfig(environment: NodeJS.ProcessEnv = process.env): PublishMediaConfig {
  const driver = environment['IMAGE_GENERATION_DRIVER']?.trim().toLowerCase() ?? 'disabled';
  return Object.freeze({
    enabled: (environment['IMAGE_AUTOMATION_ENABLED']?.trim().toLowerCase() ?? 'true') !== 'false',
    generationModel:
      driver === 'cloudflare'
        ? (environment['CLOUDFLARE_IMAGE_MODEL']?.trim() ?? '@cf/black-forest-labs/flux-1-schnell')
        : null,
    inspectionModel:
      driver === 'cloudflare'
        ? (environment['CLOUDFLARE_IMAGE_QA_MODEL']?.trim() ??
          '@cf/meta/llama-3.2-11b-vision-instruct')
        : null,
    plannerModelKey:
      environment['IMAGE_PLANNER_MODEL_KEY']?.trim() ??
      environment['CONTENT_MODEL_BALANCED_KEY']?.trim() ??
      'deepseek-v4-flash',
    provider: driver === 'cloudflare' ? 'cloudflare' : null,
  });
}

function isMediaPlatform(
  value: string,
): value is 'baijiahao' | 'douyin' | 'lieju' | 'official_site' | 'sohu' {
  return ['baijiahao', 'douyin', 'lieju', 'official_site', 'sohu'].includes(value);
}

function isBrowserPlatform(value: string): value is 'baijiahao' | 'douyin' | 'lieju' | 'sohu' {
  return value === 'baijiahao' || value === 'douyin' || value === 'lieju' || value === 'sohu';
}

function boundedRequestId(value: string): string {
  return value.slice(0, 80);
}
