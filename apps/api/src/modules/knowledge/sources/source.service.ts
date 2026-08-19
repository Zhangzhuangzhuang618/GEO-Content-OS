import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';

import { OutboxWriter } from '../../outbox/index.js';
import { SourceDuplicateError, SourceNotFoundError, SourceStorageError } from './source.errors.js';
import type { ParsedFileSource, ParsedSourceUpload } from './source-upload.parser.js';
import { buildUrlSnapshotObjectKey } from './source-object-key.js';
import { SOURCE_STORAGE } from './source.tokens.js';

export interface SourceAuditContext {
  readonly ip?: string;
  readonly requestId: string;
}

export interface SourceUploadResult {
  readonly ingest_job: {
    readonly attempt_count: number;
    readonly created_at: string;
    readonly error: null;
    readonly finished_at: null;
    readonly id: string;
    readonly progress: number;
    readonly source_document_id: string;
    readonly stage: 'queued';
    readonly started_at: null;
    readonly status: 'queued';
    readonly tenant_id: string;
    readonly updated_at: string;
  };
  readonly source: {
    readonly content_hash: string;
    readonly created_at: string;
    readonly created_by: string;
    readonly effective_from: string | null;
    readonly effective_to: string | null;
    readonly id: string;
    readonly language: string;
    readonly mime_type: string;
    readonly project_id: string | null;
    readonly source_type: ParsedSourceUpload['sourceType'];
    readonly status: 'processing';
    readonly tenant_id: string;
    readonly title: string;
    readonly trust_level: ParsedSourceUpload['trustLevel'];
    readonly updated_at: string;
    readonly workspace_id: string;
  };
}

interface CreatedRows {
  readonly jobCreatedAt: Date | string;
  readonly jobId: string;
  readonly jobUpdatedAt: Date | string;
  readonly sourceCreatedAt: Date | string;
  readonly sourceId: string;
  readonly sourceUpdatedAt: Date | string;
}

@Injectable()
export class SourceService {
  public constructor(
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
    @Inject(SOURCE_STORAGE) private readonly storage: ObjectStorageAdapter,
  ) {}

  public async upload(
    transaction: TransactionSql,
    tenantId: string,
    actorUserId: string,
    input: ParsedSourceUpload,
    audit: SourceAuditContext,
  ): Promise<SourceUploadResult> {
    await lockAuthorizedScope(transaction, tenantId, actorUserId, input);
    const duplicate = await transaction<{ id: string }[]>`
      SELECT id
      FROM source_documents
      WHERE
        tenant_id = ${tenantId}
        AND workspace_id = ${input.workspaceId}
        AND (
          content_hash = ${input.contentHash}
          OR (
            ${input.kind === 'url'}
            AND source_type = 'url'
            AND uri = ${input.kind === 'url' ? input.finalUrl : ''}
          )
        )
        AND deleted_at IS NULL
      LIMIT 1
    `;
    if (duplicate.length > 0) throw new SourceDuplicateError();

    const sourceId = randomUUID();
    const ingestJobId = randomUUID();
    const objectKey =
      input.kind === 'file'
        ? buildSourceObjectKey(tenantId, input)
        : buildUrlSnapshotObjectKey(tenantId, input.workspaceId, sourceId, input.contentHash);
    let objectUri: string;
    if (input.kind === 'url') {
      objectUri = input.finalUrl;
    } else {
      try {
        objectUri = this.storage.objectUri(objectKey as string);
      } catch {
        throw new SourceStorageError();
      }
    }
    let rows: CreatedRows[];
    try {
      rows = await transaction<CreatedRows[]>`
        WITH inserted_source AS (
          INSERT INTO source_documents (
            id,
            tenant_id,
            workspace_id,
            project_id,
            title,
            source_type,
            mime_type,
            language,
            uri,
            content_hash,
            trust_level,
            effective_from,
            effective_to,
            metadata_json,
            status,
            created_by
          ) VALUES (
            ${sourceId},
            ${tenantId},
            ${input.workspaceId},
            ${input.projectId},
            ${input.title},
            ${input.sourceType},
            ${input.mimeType},
            ${input.language},
            ${objectUri},
            ${input.contentHash},
            ${input.trustLevel},
            ${input.effectiveFrom},
            ${input.effectiveTo},
            ${JSON.stringify(input.metadata)}::text::jsonb,
            'processing',
            ${actorUserId}
          )
          RETURNING id, created_at, updated_at
        ), inserted_job AS (
          INSERT INTO ingest_jobs (id, tenant_id, source_document_id)
          VALUES (${ingestJobId}, ${tenantId}, ${sourceId})
          RETURNING id, created_at, updated_at
        )
        SELECT
          inserted_source.id AS "sourceId",
          inserted_source.created_at AS "sourceCreatedAt",
          inserted_source.updated_at AS "sourceUpdatedAt",
          inserted_job.id AS "jobId",
          inserted_job.created_at AS "jobCreatedAt",
          inserted_job.updated_at AS "jobUpdatedAt"
        FROM inserted_source CROSS JOIN inserted_job
      `;
    } catch (error) {
      if (isDuplicateSourceConstraint(error)) throw new SourceDuplicateError();
      throw error;
    }
    const created = rows[0];
    if (!created) throw new Error('Source and ingest job creation did not return a row');

    try {
      await this.storage.putObject({
        body: input.body,
        contentHash: input.contentHash,
        contentType: input.mimeType,
        key: objectKey,
        metadata: {
          content_hash: input.contentHash,
          source_id: sourceId,
          tenant_id: tenantId,
          workspace_id: input.workspaceId,
        },
      });
    } catch {
      throw new SourceStorageError();
    }

    await this.outboxWriter.enqueue(
      {
        aggregateId: sourceId,
        aggregateType: 'source_document',
        data: {
          content_hash: input.contentHash,
          ingest_job_id: ingestJobId,
          object_key: objectKey,
          ...(input.kind === 'url'
            ? { redirect_chain: [...input.redirectChain], source_url: input.finalUrl }
            : {}),
          source_document_id: sourceId,
          workspace_id: input.workspaceId,
        },
        eventType: 'knowledge.source.ingest_requested.v1',
        tenantId,
      },
      transaction,
    );
    await insertSourceAudit(transaction, {
      actorUserId,
      audit,
      input,
      sourceId,
      tenantId,
    });
    return toUploadResult(created, tenantId, actorUserId, input);
  }
}

async function lockAuthorizedScope(
  transaction: TransactionSql,
  tenantId: string,
  actorUserId: string,
  input: ParsedSourceUpload,
): Promise<void> {
  const workspace = await transaction<{ id: string }[]>`
    SELECT workspace.id
    FROM workspaces AS workspace
    WHERE
      workspace.id = ${input.workspaceId}
      AND workspace.tenant_id = ${tenantId}
      AND workspace.status = 'active'
      AND workspace.deleted_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM memberships AS membership
        WHERE
          membership.tenant_id = ${tenantId}
          AND membership.user_id = ${actorUserId}
          AND membership.status = 'active'
          AND membership.role_code IN (
            'tenant_owner', 'tenant_admin', 'strategy_editor', 'content_editor'
          )
      )
      AND has_project_scope_access(
        ${tenantId},
        workspace.id,
        ${input.projectId},
        ${actorUserId}
      )
    FOR SHARE
  `;
  if (workspace.length !== 1) throw new SourceNotFoundError();
  if (!input.projectId) return;
  const project = await transaction<{ id: string }[]>`
    SELECT id
    FROM projects
    WHERE
      id = ${input.projectId}
      AND tenant_id = ${tenantId}
      AND workspace_id = ${input.workspaceId}
      AND status = 'active'
      AND deleted_at IS NULL
    FOR SHARE
  `;
  if (project.length !== 1) throw new SourceNotFoundError();
}

function buildSourceObjectKey(tenantId: string, input: ParsedFileSource): string {
  return `tenants/${tenantId}/workspaces/${input.workspaceId}/sources/${input.contentHash}.${input.extension}`;
}

async function insertSourceAudit(
  transaction: TransactionSql,
  input: {
    readonly actorUserId: string;
    readonly audit: SourceAuditContext;
    readonly input: ParsedSourceUpload;
    readonly sourceId: string;
    readonly tenantId: string;
  },
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    INSERT INTO audit_events (
      tenant_id,
      actor_id,
      action,
      resource_type,
      resource_id,
      after_json,
      ip,
      request_id
    ) VALUES (
      ${input.tenantId},
      ${input.actorUserId},
      'knowledge.source.uploaded',
      'source_document',
      ${input.sourceId},
      ${JSON.stringify({
        content_hash: input.input.contentHash,
        mime_type: input.input.mimeType,
        material_kind: sourceMaterialKind(input.input.metadata),
        project_id: input.input.projectId,
        ...(input.input.kind === 'url' ? { source_url: input.input.finalUrl } : {}),
        size_bytes: input.input.body.byteLength,
        status: 'processing',
        workspace_id: input.input.workspaceId,
      })}::text::jsonb,
      ${input.audit.ip ?? null},
      ${input.audit.requestId}
    )
    RETURNING id
  `;
  if (rows.length !== 1) throw new Error('Required source upload audit write failed');
}

function toUploadResult(
  row: CreatedRows,
  tenantId: string,
  actorUserId: string,
  input: ParsedSourceUpload,
): SourceUploadResult {
  return {
    ingest_job: {
      attempt_count: 0,
      created_at: toIso(row.jobCreatedAt),
      error: null,
      finished_at: null,
      id: row.jobId,
      progress: 0,
      source_document_id: row.sourceId,
      stage: 'queued',
      started_at: null,
      status: 'queued',
      tenant_id: tenantId,
      updated_at: toIso(row.jobUpdatedAt),
    },
    source: {
      content_hash: input.contentHash,
      created_at: toIso(row.sourceCreatedAt),
      created_by: actorUserId,
      effective_from: input.effectiveFrom,
      effective_to: input.effectiveTo,
      id: row.sourceId,
      language: input.language,
      mime_type: input.mimeType,
      project_id: input.projectId,
      source_type: input.sourceType,
      status: 'processing',
      tenant_id: tenantId,
      title: input.title,
      trust_level: input.trustLevel,
      updated_at: toIso(row.sourceUpdatedAt),
      workspace_id: input.workspaceId,
    },
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sourceMaterialKind(
  metadata: ParsedSourceUpload['metadata'],
): 'certificate' | 'document' | 'insurance_proof' {
  if (!('schema_version' in metadata)) return 'document';
  if (metadata.schema_version === 'source-certificate@1') return 'certificate';
  if (metadata.schema_version === 'source-insurance-proof@1') return 'insurance_proof';
  return 'document';
}

function isDuplicateSourceConstraint(error: unknown): boolean {
  const candidate = error as { readonly code?: unknown; readonly constraint_name?: unknown };
  return (
    candidate.code === '23505' &&
    ['uq_source_hash_active', 'uq_source_url_active'].includes(String(candidate.constraint_name))
  );
}
