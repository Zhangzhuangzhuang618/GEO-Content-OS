import type {
  CertificateSourceProfile,
  FactQuery,
  FactView,
  IngestJobView,
  InsuranceProofSourceProfile,
  ReindexRequest,
  ReasonRequest,
  SourceChunkView,
  SourceListItem,
  SourceListQuery,
  SourceScopeQuery,
  SourceView,
} from '@geo-content-os/contracts';
import {
  CertificateSourceProfileSchema,
  InsuranceProofSourceProfileSchema,
} from '@geo-content-os/contracts';
import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import type { WebFetchAdapter } from '@geo-content-os/adapter-web-fetch';
import { Inject, Injectable } from '@nestjs/common';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';

import { IdentityAuthDatabase } from '../identity/auth/auth.database.js';
import { OutboxWriter } from '../outbox/index.js';
import {
  type FactSourceView as RepositoryFactSourceView,
  type FactView as RepositoryFactView,
  type IngestJobView as RepositoryIngestJobView,
  KnowledgeRepository,
  type SourceChunkView as RepositorySourceChunkView,
  type SourceDocumentListView,
  type SourceDocumentView,
} from './repositories/knowledge.repository.js';
import {
  KnowledgeApiNotFoundError,
  KnowledgeApiStateError,
  KnowledgeApiValidationError,
  KnowledgeApiVersionConflictError,
} from './knowledge-api.errors.js';
import { buildUrlSnapshotObjectKey } from './sources/source-object-key.js';
import { SOURCE_STORAGE, SOURCE_WEB_FETCH } from './sources/source.tokens.js';

export interface KnowledgeAuditContext {
  readonly ip?: string;
  readonly requestId: string;
}

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface SourceDetailView {
  readonly certificate: CertificateSourceProfile | null;
  readonly chunks: readonly SourceChunkView[];
  readonly citation_count: number;
  readonly facts: readonly FactView[];
  readonly ingest_jobs: readonly IngestJobView[];
  readonly insurance_proof: InsuranceProofSourceProfile | null;
  readonly source: SourceView;
}

interface IngestJobRow extends RepositoryIngestJobView {
  readonly sourceWorkspaceId?: string;
}

interface UrlSnapshot {
  readonly contentHash: string;
  readonly contentType: string;
  readonly objectKey: string;
  readonly redirectChain: readonly string[];
  readonly sourceUrl: string;
}

@Injectable()
export class KnowledgeApiService {
  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
    @Inject(SOURCE_STORAGE) private readonly storage: ObjectStorageAdapter,
    @Inject(SOURCE_WEB_FETCH) private readonly webFetch: WebFetchAdapter,
  ) {}

  public async listSources(
    tenantId: string,
    userId: string,
    query: SourceListQuery,
  ): Promise<CursorPage<SourceListItem>> {
    const repository = new KnowledgeRepository(this.database.client);
    const rows = await repository.listSourceDocuments(scope(tenantId, userId, query));
    const filtered = rows.filter((row) => {
      if (query.status && row.status !== query.status) return false;
      if (query.source_type && row.sourceType !== query.source_type) return false;
      if (query.trust_level && row.trustLevel !== query.trust_level) return false;
      return (
        !query.search || row.title.toLocaleLowerCase().includes(query.search.toLocaleLowerCase())
      );
    });
    return paginate(filtered, query.limit, query.cursor, toSourceListItem);
  }

  public async sourceDetail(
    tenantId: string,
    userId: string,
    sourceId: string,
    query: SourceScopeQuery,
  ): Promise<SourceDetailView> {
    const repository = new KnowledgeRepository(this.database.client);
    const knowledgeScope = scope(tenantId, userId, query);
    const source = await repository.findSourceDocument(knowledgeScope, sourceId);
    if (!source) throw new KnowledgeApiNotFoundError();
    const [jobs, chunks, factRows, citationRows] = await Promise.all([
      repository.listIngestJobs(knowledgeScope, sourceId),
      repository.listSourceChunks(knowledgeScope, sourceId),
      repository.listFacts(knowledgeScope),
      this.database.client<{ count: number }[]>`
        SELECT count(DISTINCT citation.id)::int AS count
        FROM ai_citations AS citation
        JOIN source_chunks AS chunk
          ON chunk.id = citation.chunk_id
          AND chunk.tenant_id = citation.tenant_id
        JOIN content_versions AS content_version
          ON content_version.id = citation.content_version_id
          AND content_version.tenant_id = citation.tenant_id
        JOIN content_variants AS variant
          ON variant.id = content_version.variant_id
          AND variant.tenant_id = content_version.tenant_id
        JOIN content_packages AS package
          ON package.id = variant.package_id
          AND package.tenant_id = variant.tenant_id
        WHERE chunk.source_document_id = ${sourceId}::uuid
          AND citation.tenant_id = ${tenantId}::uuid
          AND package.workspace_id = ${query.workspace_id}::uuid
          AND package.project_id = ${query.project_id}::uuid
          AND has_project_scope_access(
            package.tenant_id,
            package.workspace_id,
            package.project_id,
            ${userId}::uuid
          )
      `,
    ]);
    const factsWithEvidence = await Promise.all(
      factRows.map(async (fact) => ({
        evidence: await repository.listFactSources(knowledgeScope, fact.id),
        fact,
      })),
    );
    const related = factsWithEvidence.filter(({ evidence }) =>
      evidence.some((item) => item.sourceDocumentId === sourceId),
    );
    return {
      certificate: certificateProfile(source.metadata),
      chunks: chunks.map(toChunkView),
      citation_count: citationRows[0]?.count ?? 0,
      facts: related.map(({ evidence, fact }) => toFactView(fact, evidence)),
      ingest_jobs: jobs.map(toIngestJobView),
      insurance_proof: insuranceProofProfile(source.metadata),
      source: toSourceView(source),
    };
  }

  public async getIngestJob(
    tenantId: string,
    userId: string,
    jobId: string,
    query: SourceScopeQuery,
  ): Promise<IngestJobView> {
    const rows = await this.database.client<IngestJobRow[]>`
      SELECT
        job.id,
        job.tenant_id AS "tenantId",
        job.source_document_id AS "sourceDocumentId",
        job.status,
        job.attempt_count AS "attemptCount",
        job.stage,
        job.progress,
        job.error_json AS error,
        job.started_at AS "startedAt",
        job.finished_at AS "finishedAt",
        job.created_at AS "createdAt",
        job.updated_at AS "updatedAt"
      FROM ingest_jobs AS job
      JOIN source_documents AS source
        ON source.id = job.source_document_id AND source.tenant_id = job.tenant_id
      JOIN projects AS project_context
        ON project_context.id = ${query.project_id}::uuid
        AND project_context.tenant_id = source.tenant_id
        AND project_context.workspace_id = source.workspace_id
        AND project_context.deleted_at IS NULL
      WHERE
        job.id = ${jobId}::uuid
        AND job.tenant_id = ${tenantId}::uuid
        AND source.workspace_id = ${query.workspace_id}::uuid
        AND (source.project_id IS NULL OR source.project_id = ${query.project_id}::uuid)
        AND source.deleted_at IS NULL
        AND has_project_scope_access(source.tenant_id, source.workspace_id, ${query.project_id}::uuid, ${userId}::uuid)
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw new KnowledgeApiNotFoundError();
    return toIngestJobView(row);
  }

  public async listFacts(
    tenantId: string,
    userId: string,
    query: FactQuery,
  ): Promise<CursorPage<FactView>> {
    const repository = new KnowledgeRepository(this.database.client);
    const knowledgeScope = scope(tenantId, userId, query);
    const rows = await repository.listFacts(knowledgeScope);
    const enriched = await Promise.all(
      rows.map(async (fact) => ({
        evidence: await repository.listFactSources(knowledgeScope, fact.id),
        fact,
      })),
    );
    const filtered = enriched.filter(({ evidence, fact }) => {
      if (query.status && fact.status !== query.status) return false;
      if (query.subject && fact.subject !== query.subject) return false;
      if (query.predicate && fact.predicate !== query.predicate) return false;
      if (query.source_id && !evidence.some((item) => item.sourceDocumentId === query.source_id))
        return false;
      if (!query.search) return true;
      const value = `${fact.subject}\n${fact.predicate}\n${fact.objectValue}`.toLocaleLowerCase();
      return value.includes(query.search.toLocaleLowerCase());
    });
    return paginate(filtered, query.limit, query.cursor, ({ evidence, fact }) =>
      toFactView(fact, evidence),
    );
  }

  public async reindex(
    tenantId: string,
    userId: string,
    sourceId: string,
    input: ReindexRequest,
    audit: KnowledgeAuditContext,
  ): Promise<IngestJobView> {
    const initialSource = await this.database.client.begin((transaction) =>
      lockManagedSource(transaction, tenantId, userId, sourceId),
    );
    if (initialSource.contentHash !== input.expected_content_hash) {
      throw new KnowledgeApiVersionConflictError();
    }
    if (initialSource.status === 'expired')
      throw new KnowledgeApiStateError('Expired sources cannot be reindexed');
    const urlSnapshot =
      initialSource.sourceType === 'url' ? await this.prepareUrlSnapshot(initialSource) : undefined;

    return this.database.client.begin(async (transaction) => {
      const source = await lockManagedSource(transaction, tenantId, userId, sourceId);
      if (source.contentHash !== input.expected_content_hash) {
        throw new KnowledgeApiVersionConflictError();
      }
      if (source.status === 'expired')
        throw new KnowledgeApiStateError('Expired sources cannot be reindexed');
      const active = await transaction<IngestJobRow[]>`
        SELECT
          id,
          tenant_id AS "tenantId",
          source_document_id AS "sourceDocumentId",
          status,
          attempt_count AS "attemptCount",
          stage,
          progress,
          error_json AS error,
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM ingest_jobs
        WHERE tenant_id = ${tenantId}::uuid AND source_document_id = ${sourceId}::uuid
          AND status IN ('queued', 'running')
        ORDER BY created_at DESC, id
        LIMIT 1
      `;
      if (active[0]) return toIngestJobView(active[0]);
      let contentHash = source.contentHash;
      let mimeType = source.mimeType;
      if (urlSnapshot && urlSnapshot.contentHash !== source.contentHash) {
        if (source.status !== 'failed') {
          throw new KnowledgeApiStateError('A changed active URL must be registered as new source');
        }
        const [usage, duplicate] = await Promise.all([
          transaction<{ count: number }[]>`
            SELECT count(*)::integer AS count
            FROM source_chunks
            WHERE tenant_id = ${tenantId}::uuid AND source_document_id = ${sourceId}::uuid
          `,
          transaction<{ id: string }[]>`
            SELECT id
            FROM source_documents
            WHERE tenant_id = ${tenantId}::uuid
              AND workspace_id = ${source.workspaceId}::uuid
              AND content_hash = ${urlSnapshot.contentHash}
              AND id <> ${sourceId}::uuid
              AND deleted_at IS NULL
            LIMIT 1
          `,
        ]);
        if ((usage[0]?.count ?? 0) > 0 || duplicate[0]) {
          throw new KnowledgeApiStateError('URL snapshot cannot safely replace this source');
        }
        await transaction`
          UPDATE source_documents
          SET
            content_hash = ${urlSnapshot.contentHash},
            mime_type = ${urlSnapshot.contentType},
            updated_at = now()
          WHERE id = ${sourceId}::uuid AND tenant_id = ${tenantId}::uuid
        `;
        contentHash = urlSnapshot.contentHash;
        mimeType = urlSnapshot.contentType;
      }
      const jobId = randomUUID();
      const jobs = await transaction<IngestJobRow[]>`
        WITH updated_source AS (
          UPDATE source_documents
          SET status = 'processing', updated_at = now()
          WHERE id = ${sourceId}::uuid AND tenant_id = ${tenantId}::uuid
          RETURNING id
        )
        INSERT INTO ingest_jobs (id, tenant_id, source_document_id)
        SELECT ${jobId}::uuid, ${tenantId}::uuid, id FROM updated_source
        RETURNING
          id,
          tenant_id AS "tenantId",
          source_document_id AS "sourceDocumentId",
          status,
          attempt_count AS "attemptCount",
          stage,
          progress,
          error_json AS error,
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `;
      const job = jobs[0];
      if (!job) throw new Error('Reindex job creation returned no row');
      await this.outboxWriter.enqueue(
        {
          aggregateId: sourceId,
          aggregateType: 'source_document',
          data: {
            content_hash: contentHash,
            ingest_job_id: jobId,
            ...(source.sourceType === 'url'
              ? {
                  object_key:
                    urlSnapshot?.objectKey ??
                    buildUrlSnapshotObjectKey(tenantId, source.workspaceId, sourceId, contentHash),
                  redirect_chain: [...(urlSnapshot?.redirectChain ?? [])],
                  source_url: urlSnapshot?.sourceUrl ?? source.uri,
                }
              : { object_key: objectKeyFromUri(source.uri) }),
            source_document_id: sourceId,
            workspace_id: source.workspaceId,
          },
          eventType: 'knowledge.source.ingest_requested.v1',
          tenantId,
        },
        transaction,
      );
      await insertAudit(
        transaction,
        tenantId,
        userId,
        'knowledge.source.reindex_requested',
        sourceId,
        null,
        {
          content_hash: contentHash,
          ingest_job_id: jobId,
          mime_type: mimeType,
          reason: input.reason,
        },
        audit,
      );
      return toIngestJobView(job);
    });
  }

  private async prepareUrlSnapshot(source: SourceDocumentView): Promise<UrlSnapshot> {
    const existingKey = buildUrlSnapshotObjectKey(
      source.tenantId,
      source.workspaceId,
      source.id,
      source.contentHash,
    );
    const metadata = await this.storage.headObject(existingKey);
    if (metadata && metadata.contentLength > 0) {
      return {
        contentHash: source.contentHash,
        contentType: source.mimeType,
        objectKey: existingKey,
        redirectChain: [],
        sourceUrl: source.uri,
      };
    }
    const fetched = await this.webFetch.fetch(source.uri);
    if (source.status !== 'failed' && fetched.contentHash !== source.contentHash) {
      throw new KnowledgeApiStateError('The URL changed after its last successful indexing');
    }
    const objectKey = buildUrlSnapshotObjectKey(
      source.tenantId,
      source.workspaceId,
      source.id,
      fetched.contentHash,
    );
    await this.storage.putObject({
      body: fetched.body,
      contentHash: fetched.contentHash,
      contentType: fetched.contentType,
      key: objectKey,
      metadata: {
        content_hash: fetched.contentHash,
        source_id: source.id,
        tenant_id: source.tenantId,
        workspace_id: source.workspaceId,
      },
    });
    return {
      contentHash: fetched.contentHash,
      contentType: fetched.contentType,
      objectKey,
      redirectChain: fetched.redirectChain,
      sourceUrl: source.uri,
    };
  }

  public async deleteSource(
    tenantId: string,
    userId: string,
    sourceId: string,
    expectedUpdatedAt: string,
    input: ReasonRequest,
    audit: KnowledgeAuditContext,
  ): Promise<void> {
    await this.database.client.begin(async (transaction) => {
      const source = await lockManagedSource(transaction, tenantId, userId, sourceId);
      if (toIso(source.updatedAt) !== expectedUpdatedAt) {
        throw new KnowledgeApiVersionConflictError();
      }
      await transaction`
        UPDATE source_documents
        SET status = 'expired', deleted_at = now(), updated_at = now()
        WHERE id = ${sourceId}::uuid AND tenant_id = ${tenantId}::uuid
      `;
      await transaction`
        UPDATE source_chunks
        SET status = 'inactive'
        WHERE source_document_id = ${sourceId}::uuid AND tenant_id = ${tenantId}::uuid
      `;
      await transaction`
        UPDATE ingest_jobs
        SET status = 'cancelled', started_at = COALESCE(started_at, now()), finished_at = now(), updated_at = now()
        WHERE source_document_id = ${sourceId}::uuid AND tenant_id = ${tenantId}::uuid
          AND status IN ('queued', 'running')
      `;
      await insertAudit(
        transaction,
        tenantId,
        userId,
        'knowledge.source.invalidated',
        sourceId,
        toSourceView(source),
        { reason: input.reason, status: 'expired' },
        audit,
      );
    });
  }
}

function certificateProfile(metadata: unknown): CertificateSourceProfile | null {
  const parsed = CertificateSourceProfileSchema.safeParse(metadata);
  return parsed.success ? parsed.data : null;
}

function insuranceProofProfile(metadata: unknown): InsuranceProofSourceProfile | null {
  const parsed = InsuranceProofSourceProfileSchema.safeParse(metadata);
  return parsed.success ? parsed.data : null;
}

function scope(tenantId: string, userId: string, query: SourceScopeQuery) {
  return { projectId: query.project_id, tenantId, userId, workspaceId: query.workspace_id };
}

async function lockManagedSource(
  transaction: TransactionSql,
  tenantId: string,
  userId: string,
  sourceId: string,
): Promise<SourceDocumentView> {
  const rows = await transaction<SourceDocumentView[]>`
    SELECT
      source.id,
      source.tenant_id AS "tenantId",
      source.workspace_id AS "workspaceId",
      source.project_id AS "projectId",
      source.title,
      source.source_type AS "sourceType",
      source.mime_type AS "mimeType",
      source.metadata_json AS metadata,
      source.language,
      source.uri,
      source.content_hash AS "contentHash",
      source.trust_level AS "trustLevel",
      source.effective_from::text AS "effectiveFrom",
      source.effective_to::text AS "effectiveTo",
      source.status,
      source.created_by AS "createdBy",
      source.created_at AS "createdAt",
      source.updated_at AS "updatedAt",
      source.deleted_at AS "deletedAt"
    FROM source_documents AS source
    JOIN memberships AS membership
      ON membership.tenant_id = source.tenant_id AND membership.user_id = ${userId}::uuid
      AND membership.status = 'active'
      AND membership.role_code IN ('tenant_owner', 'tenant_admin', 'strategy_editor', 'content_editor')
    WHERE source.id = ${sourceId}::uuid AND source.tenant_id = ${tenantId}::uuid
      AND source.deleted_at IS NULL
      AND (
        (source.project_id IS NULL AND has_workspace_scope_access(source.tenant_id, source.workspace_id, ${userId}::uuid))
        OR has_project_scope_access(source.tenant_id, source.workspace_id, source.project_id, ${userId}::uuid)
      )
    LIMIT 1
    FOR UPDATE OF source
  `;
  const source = rows[0];
  if (!source) throw new KnowledgeApiNotFoundError();
  return source;
}

async function insertAudit(
  transaction: TransactionSql,
  tenantId: string,
  actorId: string,
  action: string,
  resourceId: string,
  before: unknown,
  after: unknown,
  audit: KnowledgeAuditContext,
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    INSERT INTO audit_events (tenant_id, actor_id, action, resource_type, resource_id, before_json, after_json, ip, request_id)
    VALUES (${tenantId}::uuid, ${actorId}::uuid, ${action}, 'source_document', ${resourceId}::uuid,
      ${before === null ? null : JSON.stringify(before)}::text::jsonb,
      ${JSON.stringify(after)}::text::jsonb, ${audit.ip ?? null}, ${audit.requestId})
    RETURNING id
  `;
  if (rows.length !== 1) throw new Error('Required knowledge audit write failed');
}

function objectKeyFromUri(uri: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/iu.exec(uri);
  if (!match?.[1]) throw new KnowledgeApiStateError('Stored source URI cannot be reindexed');
  return match[1];
}

function paginate<T, V>(
  values: readonly T[],
  limit: number,
  cursor: string | undefined,
  map: (value: T) => V,
): CursorPage<V> {
  const offset = cursor ? decodeCursor(cursor) : 0;
  if (offset > values.length)
    throw new KnowledgeApiValidationError('Cursor is outside the result set');
  const window = values.slice(offset, offset + limit + 1);
  return {
    items: window.slice(0, limit).map(map),
    nextCursor: window.length > limit ? encodeCursor(offset + limit) : null,
  };
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset, version: 1 }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (value.version !== 1 || !Number.isSafeInteger(value.offset) || Number(value.offset) < 0)
      throw new Error();
    return Number(value.offset);
  } catch {
    throw new KnowledgeApiValidationError('Cursor is malformed');
  }
}

function toSourceView(row: SourceDocumentView): SourceView {
  return {
    content_hash: row.contentHash,
    created_at: toIso(row.createdAt),
    created_by: row.createdBy,
    effective_from: row.effectiveFrom,
    effective_to: row.effectiveTo,
    id: row.id,
    language: row.language,
    mime_type: row.mimeType,
    project_id: row.projectId,
    source_type: row.sourceType,
    status: row.status,
    tenant_id: row.tenantId,
    title: row.title,
    trust_level: row.trustLevel,
    updated_at: toIso(row.updatedAt),
    workspace_id: row.workspaceId,
  };
}

function toSourceListItem(row: SourceDocumentListView): SourceListItem {
  return {
    ...toSourceView(row),
    parsed_at: row.parsedAt ? toIso(row.parsedAt) : null,
  };
}

function toIngestJobView(row: RepositoryIngestJobView): IngestJobView {
  return {
    attempt_count: row.attemptCount,
    created_at: toIso(row.createdAt),
    error: row.error
      ? {
          code: row.error.code,
          message: row.error.message,
          schema_version: row.error.schema_version,
        }
      : null,
    finished_at: row.finishedAt ? toIso(row.finishedAt) : null,
    id: row.id,
    progress: row.progress,
    source_document_id: row.sourceDocumentId,
    stage: row.stage,
    started_at: row.startedAt ? toIso(row.startedAt) : null,
    status: row.status,
    tenant_id: row.tenantId,
    updated_at: toIso(row.updatedAt),
  };
}

function toChunkView(row: RepositorySourceChunkView): SourceChunkView {
  if (row.metadata.char_start === undefined || row.metadata.char_end === undefined) {
    throw new KnowledgeApiStateError('Stored chunk is missing its required source locator');
  }
  return {
    chunk_no: row.chunkNo,
    created_at: toIso(row.createdAt),
    id: row.id,
    metadata: {
      char_end: row.metadata.char_end,
      char_start: row.metadata.char_start,
      ...(row.metadata.headings ? { headings: [...row.metadata.headings] } : {}),
      ...(row.metadata.page ? { page: row.metadata.page } : {}),
      schema_version: row.metadata.schema_version,
      ...(row.metadata.url ? { url: row.metadata.url } : {}),
    },
    source_document_id: row.sourceDocumentId,
    status: row.status,
    text: row.text,
    text_hash: row.textHash,
    token_count: row.tokenCount,
  };
}

function toFactView(
  row: RepositoryFactView,
  evidence: readonly RepositoryFactSourceView[],
): FactView {
  return {
    confidence: Number(row.confidence),
    created_at: toIso(row.createdAt),
    evidence: evidence.map((item) => ({
      chunk_id: item.chunkId,
      created_at: toIso(item.createdAt),
      id: item.id,
      quote_hash: item.quoteHash,
      quote_text: item.quoteText,
      source_document_id: item.sourceDocumentId,
    })),
    id: row.id,
    object_value: row.objectValue,
    predicate: row.predicate,
    status: row.status,
    subject: row.subject,
    tenant_id: row.tenantId,
    unit: row.unit,
    updated_at: toIso(row.updatedAt),
    valid_from: row.validFrom,
    valid_to: row.validTo,
    workspace_id: row.workspaceId,
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
