import type { DatabaseClient } from '../../../database/index.js';
import type {
  ChunkMetadata,
  FactStatus,
  IngestJobError,
  IngestJobStatus,
  IngestStage,
  SourceChunkStatus,
  SourceDocumentStatus,
  SourceDocumentMetadata,
  SourceTrustLevel,
  SourceType,
} from '../../../database/schema/index.js';

export interface KnowledgeScope {
  readonly projectId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

export interface SourceDocumentView {
  readonly contentHash: string;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly deletedAt: Date | null;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly id: string;
  readonly language: string;
  readonly mimeType: string;
  readonly metadata: SourceDocumentMetadata;
  readonly projectId: string | null;
  readonly sourceType: SourceType;
  readonly status: SourceDocumentStatus;
  readonly tenantId: string;
  readonly title: string;
  readonly trustLevel: SourceTrustLevel;
  readonly updatedAt: Date;
  readonly uri: string;
  readonly workspaceId: string;
}

export interface SourceDocumentListView extends SourceDocumentView {
  readonly parsedAt: Date | null;
}

export interface IngestJobView {
  readonly attemptCount: number;
  readonly createdAt: Date;
  readonly error: IngestJobError | null;
  readonly finishedAt: Date | null;
  readonly id: string;
  readonly progress: number;
  readonly sourceDocumentId: string;
  readonly stage: IngestStage;
  readonly startedAt: Date | null;
  readonly status: IngestJobStatus;
  readonly tenantId: string;
  readonly updatedAt: Date;
}

export interface SourceChunkView {
  readonly chunkNo: number;
  readonly createdAt: Date;
  readonly id: string;
  readonly metadata: ChunkMetadata;
  readonly sourceDocumentId: string;
  readonly status: SourceChunkStatus;
  readonly tenantId: string;
  readonly text: string;
  readonly textHash: string;
  readonly tokenCount: number;
}

export interface FactView {
  readonly confidence: string;
  readonly createdAt: Date;
  readonly id: string;
  readonly objectValue: string;
  readonly predicate: string;
  readonly status: FactStatus;
  readonly subject: string;
  readonly tenantId: string;
  readonly unit: string | null;
  readonly updatedAt: Date;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly workspaceId: string;
}

export interface FactSourceView {
  readonly chunkId: string;
  readonly createdAt: Date;
  readonly factId: string;
  readonly id: string;
  readonly quoteHash: string;
  readonly quoteText: string;
  readonly sourceDocumentId: string;
  readonly tenantId: string;
}

/**
 * Read paths are always bound to tenant, workspace, project and user. A project context can consume
 * workspace-shared sources (`project_id IS NULL`) but cannot cross into another project.
 */
export class KnowledgeRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async findSourceDocument(
    scope: KnowledgeScope,
    sourceDocumentId: string,
  ): Promise<SourceDocumentView | undefined> {
    const rows = await this.client<SourceDocumentView[]>`
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
      JOIN workspaces AS workspace
        ON workspace.id = source.workspace_id
        AND workspace.tenant_id = source.tenant_id
      JOIN projects AS project_context
        ON project_context.id = ${scope.projectId}
        AND project_context.tenant_id = source.tenant_id
        AND project_context.workspace_id = source.workspace_id
        AND project_context.deleted_at IS NULL
      WHERE
        source.id = ${sourceDocumentId}
        AND source.tenant_id = ${scope.tenantId}
        AND source.workspace_id = ${scope.workspaceId}
        AND (source.project_id IS NULL OR source.project_id = ${scope.projectId})
        AND source.deleted_at IS NULL
        AND workspace.deleted_at IS NULL
        AND has_project_scope_access(
          source.tenant_id,
          source.workspace_id,
          ${scope.projectId},
          ${scope.userId}
        )
      LIMIT 1
    `;
    return rows[0];
  }

  public async listSourceDocuments(
    scope: KnowledgeScope,
  ): Promise<readonly SourceDocumentListView[]> {
    return this.client<SourceDocumentListView[]>`
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
        source.deleted_at AS "deletedAt",
        (
          SELECT max(job.finished_at)
          FROM ingest_jobs AS job
          WHERE job.tenant_id = source.tenant_id
            AND job.source_document_id = source.id
        ) AS "parsedAt"
      FROM source_documents AS source
      JOIN workspaces AS workspace
        ON workspace.id = source.workspace_id
        AND workspace.tenant_id = source.tenant_id
      JOIN projects AS project_context
        ON project_context.id = ${scope.projectId}
        AND project_context.tenant_id = source.tenant_id
        AND project_context.workspace_id = source.workspace_id
        AND project_context.deleted_at IS NULL
      WHERE
        source.tenant_id = ${scope.tenantId}
        AND source.workspace_id = ${scope.workspaceId}
        AND (source.project_id IS NULL OR source.project_id = ${scope.projectId})
        AND source.deleted_at IS NULL
        AND workspace.deleted_at IS NULL
        AND has_project_scope_access(
          source.tenant_id,
          source.workspace_id,
          ${scope.projectId},
          ${scope.userId}
        )
      ORDER BY source.updated_at DESC, source.id
    `;
  }

  public async listIngestJobs(
    scope: KnowledgeScope,
    sourceDocumentId: string,
  ): Promise<readonly IngestJobView[]> {
    return this.client<IngestJobView[]>`
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
        ON source.id = job.source_document_id
        AND source.tenant_id = job.tenant_id
      JOIN projects AS project_context
        ON project_context.id = ${scope.projectId}
        AND project_context.tenant_id = source.tenant_id
        AND project_context.workspace_id = source.workspace_id
        AND project_context.deleted_at IS NULL
      WHERE
        job.tenant_id = ${scope.tenantId}
        AND job.source_document_id = ${sourceDocumentId}
        AND source.workspace_id = ${scope.workspaceId}
        AND (source.project_id IS NULL OR source.project_id = ${scope.projectId})
        AND source.deleted_at IS NULL
        AND has_project_scope_access(
          source.tenant_id,
          source.workspace_id,
          ${scope.projectId},
          ${scope.userId}
        )
      ORDER BY job.created_at DESC, job.id
    `;
  }

  public async listSourceChunks(
    scope: KnowledgeScope,
    sourceDocumentId: string,
  ): Promise<readonly SourceChunkView[]> {
    return this.client<SourceChunkView[]>`
      SELECT
        chunk.id,
        chunk.tenant_id AS "tenantId",
        chunk.source_document_id AS "sourceDocumentId",
        chunk.chunk_no AS "chunkNo",
        chunk.text,
        chunk.text_hash AS "textHash",
        chunk.metadata_json AS metadata,
        chunk.token_count AS "tokenCount",
        chunk.status,
        chunk.created_at AS "createdAt"
      FROM source_chunks AS chunk
      JOIN source_documents AS source
        ON source.id = chunk.source_document_id
        AND source.tenant_id = chunk.tenant_id
      JOIN projects AS project_context
        ON project_context.id = ${scope.projectId}
        AND project_context.tenant_id = source.tenant_id
        AND project_context.workspace_id = source.workspace_id
        AND project_context.deleted_at IS NULL
      WHERE
        chunk.tenant_id = ${scope.tenantId}
        AND chunk.source_document_id = ${sourceDocumentId}
        AND source.workspace_id = ${scope.workspaceId}
        AND (source.project_id IS NULL OR source.project_id = ${scope.projectId})
        AND source.deleted_at IS NULL
        AND has_project_scope_access(
          source.tenant_id,
          source.workspace_id,
          ${scope.projectId},
          ${scope.userId}
        )
      ORDER BY chunk.chunk_no, chunk.id
    `;
  }

  public async listFacts(scope: KnowledgeScope): Promise<readonly FactView[]> {
    return this.client<FactView[]>`
      SELECT
        fact.id,
        fact.tenant_id AS "tenantId",
        fact.workspace_id AS "workspaceId",
        fact.subject,
        fact.predicate,
        fact.object_value AS "objectValue",
        fact.unit,
        fact.valid_from::text AS "validFrom",
        fact.valid_to::text AS "validTo",
        fact.confidence::text AS confidence,
        fact.status,
        fact.created_at AS "createdAt",
        fact.updated_at AS "updatedAt"
      FROM facts AS fact
      JOIN workspaces AS workspace
        ON workspace.id = fact.workspace_id
        AND workspace.tenant_id = fact.tenant_id
      JOIN projects AS project_context
        ON project_context.id = ${scope.projectId}
        AND project_context.tenant_id = fact.tenant_id
        AND project_context.workspace_id = fact.workspace_id
        AND project_context.deleted_at IS NULL
      WHERE
        fact.tenant_id = ${scope.tenantId}
        AND fact.workspace_id = ${scope.workspaceId}
        AND workspace.deleted_at IS NULL
        AND has_project_scope_access(
          fact.tenant_id,
          fact.workspace_id,
          ${scope.projectId},
          ${scope.userId}
        )
        AND EXISTS (
          SELECT 1
          FROM fact_sources AS evidence
          JOIN source_chunks AS chunk
            ON chunk.id = evidence.chunk_id
            AND chunk.tenant_id = evidence.tenant_id
          JOIN source_documents AS source
            ON source.id = chunk.source_document_id
            AND source.tenant_id = chunk.tenant_id
          WHERE
            evidence.fact_id = fact.id
            AND evidence.tenant_id = fact.tenant_id
            AND source.deleted_at IS NULL
            AND (source.project_id IS NULL OR source.project_id = ${scope.projectId})
        )
      ORDER BY fact.updated_at DESC, fact.id
    `;
  }

  public async listFactSources(
    scope: KnowledgeScope,
    factId: string,
  ): Promise<readonly FactSourceView[]> {
    return this.client<FactSourceView[]>`
      SELECT
        evidence.id,
        evidence.tenant_id AS "tenantId",
        evidence.fact_id AS "factId",
        evidence.chunk_id AS "chunkId",
        chunk.source_document_id AS "sourceDocumentId",
        evidence.quote_text AS "quoteText",
        evidence.quote_hash AS "quoteHash",
        evidence.created_at AS "createdAt"
      FROM fact_sources AS evidence
      JOIN facts AS fact
        ON fact.id = evidence.fact_id
        AND fact.tenant_id = evidence.tenant_id
      JOIN source_chunks AS chunk
        ON chunk.id = evidence.chunk_id
        AND chunk.tenant_id = evidence.tenant_id
      JOIN source_documents AS source
        ON source.id = chunk.source_document_id
        AND source.tenant_id = chunk.tenant_id
      WHERE
        evidence.tenant_id = ${scope.tenantId}
        AND evidence.fact_id = ${factId}
        AND fact.workspace_id = ${scope.workspaceId}
        AND source.workspace_id = ${scope.workspaceId}
        AND (source.project_id IS NULL OR source.project_id = ${scope.projectId})
        AND source.deleted_at IS NULL
        AND has_project_scope_access(
          fact.tenant_id,
          fact.workspace_id,
          ${scope.projectId},
          ${scope.userId}
        )
      ORDER BY evidence.created_at, evidence.id
    `;
  }
}
