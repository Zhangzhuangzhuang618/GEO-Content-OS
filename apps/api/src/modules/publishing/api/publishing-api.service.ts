import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import type {
  ExportArtifactView,
  PublishAttemptView,
  PublishJobDetail,
  PublishJobQuery,
  PublishJobView,
  SignedDownloadView,
} from '@geo-content-os/contracts';
import { PublishJobParamsSchema } from '@geo-content-os/contracts';

import { resolveDatabaseClient, type DatabaseClientSource } from '../../../database/index.js';
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
  readonly origin: PublishJobView['origin'];
  readonly payloadHash: string;
  readonly publishedAt: DatabaseDate | null;
  readonly scheduledAt: DatabaseDate;
  readonly status: PublishJobView['status'];
  readonly tenantId: string;
  readonly updatedAt: DatabaseDate;
  readonly variantId: string;
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

export class PublishingApiService {
  public constructor(
    private readonly databaseSource: DatabaseClientSource,
    private readonly storage: ObjectStorageAdapter,
  ) {}

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
        job.published_at AS "publishedAt",
        job.created_by AS "createdBy", job.created_at AS "createdAt",
        job.updated_at AS "updatedAt", job.version
      FROM publish_jobs AS job
      JOIN content_variants AS variant
        ON variant.id=job.variant_id AND variant.tenant_id=job.tenant_id
      JOIN content_packages AS package
        ON package.id=variant.package_id AND package.tenant_id=variant.tenant_id
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
    const [attempts, artifact] = await Promise.all([
      this.attemptRows(scope, jobId),
      this.latestArtifact(scope, jobId),
    ]);
    return {
      attempts: attempts.map(mapAttempt),
      export_artifact: artifact ? mapArtifact(artifact) : null,
      job: mapJob(job),
    };
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
        job.created_by AS "createdBy",
        job.created_at AS "createdAt",job.updated_at AS "updatedAt",job.version
      FROM publish_jobs AS job
      JOIN content_variants AS variant ON variant.id=job.variant_id AND variant.tenant_id=job.tenant_id
      JOIN content_packages AS package ON package.id=variant.package_id AND package.tenant_id=variant.tenant_id
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
