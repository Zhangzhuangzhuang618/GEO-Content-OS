import type { PlatformCode } from '@geo-content-os/contracts';

import type { DatabaseClient } from '../../../database/index.js';

export interface PublishingScope {
  readonly tenantId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

export interface PlatformAccountView {
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
  readonly displayName: string;
  readonly id: string;
  readonly platformCode: PlatformCode;
  readonly providerAccountId: string | null;
  readonly publishingUrl: string | null;
  readonly publishMode: 'api' | 'export' | 'manual';
  readonly scopes: readonly string[];
  readonly status: 'active' | 'reauth' | 'disabled';
  readonly tenantId: string;
  readonly timezone: string;
  readonly tokenExpiresAt: Date | null;
  readonly updatedAt: Date;
  readonly workspaceId: string;
}

export interface MediaAssetView {
  readonly assetType: 'image' | 'video' | 'audio' | 'document' | 'screenshot';
  readonly contentHash: string;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly deletedAt: Date | null;
  readonly id: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly mimeType: string;
  readonly objectUri: string;
  readonly projectId: string | null;
  readonly sizeBytes: string;
  readonly tenantId: string;
  readonly updatedAt: Date;
  readonly workspaceId: string;
}

export interface PublishJobView {
  readonly accountId: string;
  readonly attemptCount: number;
  readonly contentVersionId: string;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly externalPostId: string | null;
  readonly externalUrl: string | null;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly lastError: Readonly<Record<string, unknown>> | null;
  readonly origin: 'manual' | 'official_site_automation';
  readonly payloadHash: string;
  readonly publishedAt: Date | null;
  readonly scheduledAt: Date;
  readonly status:
    'scheduled' | 'publishing' | 'published' | 'failed' | 'cancel_requested' | 'cancelled';
  readonly tenantId: string;
  readonly updatedAt: Date;
  readonly variantId: string;
}

export interface PublishAttemptView {
  readonly adapterCode: string;
  readonly attemptNo: number;
  readonly createdAt: Date;
  readonly errorCode: string | null;
  readonly finishedAt: Date | null;
  readonly id: string;
  readonly publishJobId: string;
  readonly requestHash: string;
  readonly response: Readonly<Record<string, unknown>> | null;
  readonly startedAt: Date;
  readonly status: 'running' | 'succeeded' | 'failed' | 'unknown';
  readonly tenantId: string;
}

export interface ExportArtifactView {
  readonly contentHash: string;
  readonly contentVersionId: string;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly expiresAt: Date;
  readonly id: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly objectUri: string;
  readonly publishJobId: string | null;
  readonly tenantId: string;
  readonly variantId: string;
}

/** Tenant-scoped publishing reads. Credential material is deliberately absent from every view. */
export class PublishingRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async listAccounts(scope: PublishingScope): Promise<readonly PlatformAccountView[]> {
    return this.client<PlatformAccountView[]>`
      SELECT
        account.id,
        account.tenant_id AS "tenantId",
        account.workspace_id AS "workspaceId",
        account.platform_code AS "platformCode",
        account.provider_account_id AS "providerAccountId",
        account.publishing_url AS "publishingUrl",
        account.display_name AS "displayName",
        account.scopes,
        account.token_expires_at AS "tokenExpiresAt",
        account.capabilities_json AS capabilities,
        account.publish_mode AS "publishMode",
        account.status,
        account.timezone,
        account.created_at AS "createdAt",
        account.updated_at AS "updatedAt",
        account.deleted_at AS "deletedAt"
      FROM platform_accounts AS account
      WHERE account.tenant_id = ${scope.tenantId}::uuid
        AND account.workspace_id = ${scope.workspaceId}::uuid
        AND has_project_scope_access(
          account.tenant_id,
          account.workspace_id,
          NULL,
          ${scope.userId}::uuid
        )
        AND account.deleted_at IS NULL
      ORDER BY account.platform_code, account.display_name, account.id
    `;
  }

  public async findAccount(
    scope: PublishingScope,
    accountId: string,
  ): Promise<PlatformAccountView | undefined> {
    const rows = await this.client<PlatformAccountView[]>`
      SELECT
        account.id,
        account.tenant_id AS "tenantId",
        account.workspace_id AS "workspaceId",
        account.platform_code AS "platformCode",
        account.provider_account_id AS "providerAccountId",
        account.publishing_url AS "publishingUrl",
        account.display_name AS "displayName",
        account.scopes,
        account.token_expires_at AS "tokenExpiresAt",
        account.capabilities_json AS capabilities,
        account.publish_mode AS "publishMode",
        account.status,
        account.timezone,
        account.created_at AS "createdAt",
        account.updated_at AS "updatedAt",
        account.deleted_at AS "deletedAt"
      FROM platform_accounts AS account
      WHERE account.id = ${accountId}::uuid
        AND account.tenant_id = ${scope.tenantId}::uuid
        AND account.workspace_id = ${scope.workspaceId}::uuid
        AND has_project_scope_access(
          account.tenant_id,
          account.workspace_id,
          NULL,
          ${scope.userId}::uuid
        )
        AND account.deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0];
  }

  public async findMediaAsset(
    scope: PublishingScope,
    assetId: string,
  ): Promise<MediaAssetView | undefined> {
    const rows = await this.client<MediaAssetView[]>`
      SELECT
        asset.id,
        asset.tenant_id AS "tenantId",
        asset.workspace_id AS "workspaceId",
        asset.project_id AS "projectId",
        asset.asset_type AS "assetType",
        asset.object_uri AS "objectUri",
        asset.content_hash AS "contentHash",
        asset.mime_type AS "mimeType",
        asset.size_bytes::text AS "sizeBytes",
        asset.metadata_json AS metadata,
        asset.created_by AS "createdBy",
        asset.created_at AS "createdAt",
        asset.updated_at AS "updatedAt",
        asset.deleted_at AS "deletedAt"
      FROM media_assets AS asset
      WHERE asset.id = ${assetId}::uuid
        AND asset.tenant_id = ${scope.tenantId}::uuid
        AND asset.workspace_id = ${scope.workspaceId}::uuid
        AND has_project_scope_access(
          asset.tenant_id,
          asset.workspace_id,
          asset.project_id,
          ${scope.userId}::uuid
        )
        AND asset.deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0];
  }

  public async findJob(
    scope: PublishingScope,
    publishJobId: string,
  ): Promise<PublishJobView | undefined> {
    const rows = await selectJobs(this.client, scope, publishJobId);
    return rows[0];
  }

  public async listJobs(scope: PublishingScope): Promise<readonly PublishJobView[]> {
    return selectJobs(this.client, scope);
  }

  public async listAttempts(
    scope: PublishingScope,
    publishJobId: string,
  ): Promise<readonly PublishAttemptView[]> {
    return this.client<PublishAttemptView[]>`
      SELECT
        attempt.id,
        attempt.tenant_id AS "tenantId",
        attempt.publish_job_id AS "publishJobId",
        attempt.attempt_no AS "attemptNo",
        attempt.adapter_code AS "adapterCode",
        attempt.status,
        attempt.request_hash AS "requestHash",
        attempt.response_json AS response,
        attempt.error_code AS "errorCode",
        attempt.started_at AS "startedAt",
        attempt.finished_at AS "finishedAt",
        attempt.created_at AS "createdAt"
      FROM publish_attempts AS attempt
      JOIN publish_jobs AS job
        ON job.id = attempt.publish_job_id AND job.tenant_id = attempt.tenant_id
      JOIN content_variants AS variant
        ON variant.id = job.variant_id AND variant.tenant_id = job.tenant_id
      JOIN content_packages AS package
        ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
      WHERE attempt.tenant_id = ${scope.tenantId}::uuid
        AND attempt.publish_job_id = ${publishJobId}::uuid
        AND package.workspace_id = ${scope.workspaceId}::uuid
        AND has_project_scope_access(
          package.tenant_id,
          package.workspace_id,
          package.project_id,
          ${scope.userId}::uuid
        )
      ORDER BY attempt.attempt_no, attempt.id
    `;
  }

  public async listExportArtifacts(
    scope: PublishingScope,
    variantId: string,
  ): Promise<readonly ExportArtifactView[]> {
    return this.client<ExportArtifactView[]>`
      SELECT
        artifact.id,
        artifact.tenant_id AS "tenantId",
        artifact.variant_id AS "variantId",
        artifact.content_version_id AS "contentVersionId",
        artifact.publish_job_id AS "publishJobId",
        artifact.object_uri AS "objectUri",
        artifact.manifest_json AS manifest,
        artifact.content_hash AS "contentHash",
        artifact.expires_at AS "expiresAt",
        artifact.created_by AS "createdBy",
        artifact.created_at AS "createdAt"
      FROM export_artifacts AS artifact
      JOIN content_variants AS variant
        ON variant.id = artifact.variant_id AND variant.tenant_id = artifact.tenant_id
      JOIN content_packages AS package
        ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
      WHERE artifact.tenant_id = ${scope.tenantId}::uuid
        AND artifact.variant_id = ${variantId}::uuid
        AND package.workspace_id = ${scope.workspaceId}::uuid
        AND has_project_scope_access(
          package.tenant_id,
          package.workspace_id,
          package.project_id,
          ${scope.userId}::uuid
        )
      ORDER BY artifact.created_at DESC, artifact.id
    `;
  }
}

function selectJobs(
  client: DatabaseClient,
  scope: PublishingScope,
  publishJobId?: string,
): Promise<PublishJobView[]> {
  return client<PublishJobView[]>`
    SELECT
      job.id,
      job.tenant_id AS "tenantId",
      job.variant_id AS "variantId",
      job.content_version_id AS "contentVersionId",
      job.account_id AS "accountId",
      job.scheduled_at AS "scheduledAt",
      job.idempotency_key AS "idempotencyKey",
      job.payload_hash AS "payloadHash",
      job.status,
      job.attempt_count AS "attemptCount",
      job.external_post_id AS "externalPostId",
      job.external_url AS "externalUrl",
      job.last_error_json AS "lastError",
      job.origin,
      job.published_at AS "publishedAt",
      job.created_by AS "createdBy",
      job.created_at AS "createdAt",
      job.updated_at AS "updatedAt"
    FROM publish_jobs AS job
    JOIN content_variants AS variant
      ON variant.id = job.variant_id AND variant.tenant_id = job.tenant_id
    JOIN content_packages AS package
      ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
    WHERE job.tenant_id = ${scope.tenantId}::uuid
      AND package.workspace_id = ${scope.workspaceId}::uuid
      AND (${publishJobId ?? null}::uuid IS NULL OR job.id = ${publishJobId ?? null}::uuid)
      AND has_project_scope_access(
        package.tenant_id,
        package.workspace_id,
        package.project_id,
        ${scope.userId}::uuid
      )
    ORDER BY job.scheduled_at DESC, job.id
  `;
}
