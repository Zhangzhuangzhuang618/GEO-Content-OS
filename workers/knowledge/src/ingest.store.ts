import type postgres from 'postgres';

import { asIngestError, IngestWorkerError } from './ingest.errors.js';
import type {
  IngestClaim,
  IngestClaimResult,
  IngestSource,
  IngestStage,
  IngestStorePort,
  SourceChunkDraft,
  ValidatedKnowledgeIngestEvent,
} from './ingest.types.js';

interface ClaimRow {
  readonly attemptCount: number;
  readonly contentHash: string;
  readonly id: string;
  readonly language: string;
  readonly mimeType: string;
  readonly sourceStatus: string;
  readonly sourceType: string;
  readonly status: string;
  readonly title: string;
  readonly updatedAt: Date;
  readonly workspaceId: string;
}

interface ExistingChunkRow {
  readonly chunkNo: number;
  readonly metadata: unknown;
  readonly status: string;
  readonly text: string;
  readonly textHash: string;
  readonly tokenCount: number;
}

const SOURCE_TYPES = new Set(['docx', 'image', 'pdf', 'txt', 'url']);

export class PostgresIngestStore implements IngestStorePort {
  public constructor(
    private readonly client: postgres.Sql,
    private readonly staleAfterMs = 60_000,
    private readonly maxAttempts = 5,
  ) {
    if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1_000 || staleAfterMs > 900_000) {
      throw new TypeError('Ingest stale lease duration is invalid');
    }
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
      throw new TypeError('Ingest maximum attempts is invalid');
    }
  }

  public claim(event: ValidatedKnowledgeIngestEvent): Promise<IngestClaimResult> {
    return this.client.begin(async (transaction) => {
      const rows = await transaction<ClaimRow[]>`
        SELECT
          job.attempt_count AS "attemptCount",
          source.content_hash AS "contentHash",
          source.id,
          source.language,
          source.mime_type AS "mimeType",
          source.status AS "sourceStatus",
          source.source_type AS "sourceType",
          job.status,
          source.title,
          job.updated_at AS "updatedAt",
          source.workspace_id AS "workspaceId"
        FROM ingest_jobs AS job
        JOIN source_documents AS source
          ON source.id = job.source_document_id
          AND source.tenant_id = job.tenant_id
        WHERE
          job.id = ${event.data.ingestJobId}::uuid
          AND job.tenant_id = ${event.tenantId}::uuid
          AND source.id = ${event.data.sourceDocumentId}::uuid
          AND source.workspace_id = ${event.data.workspaceId}::uuid
          AND source.content_hash = ${event.data.contentHash}
          AND source.deleted_at IS NULL
        FOR UPDATE OF job, source
      `;
      const row = rows[0];
      if (!row || row.id !== event.aggregateId || !SOURCE_TYPES.has(row.sourceType)) {
        throw new IngestWorkerError('INGEST_SCOPE_INVALID', 'Knowledge ingest scope is invalid', {
          retryable: false,
        });
      }
      if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'cancelled') {
        return { kind: 'completed' } as const;
      }
      if (row.sourceStatus !== 'processing' && row.sourceStatus !== 'active') {
        throw new IngestWorkerError(
          'SOURCE_STATE_INVALID',
          'Source cannot be ingested in its state',
          {
            retryable: false,
          },
        );
      }
      if (
        row.status === 'running' &&
        Date.now() - new Date(row.updatedAt).getTime() < this.staleAfterMs
      ) {
        return { kind: 'busy' } as const;
      }
      const attempt = row.attemptCount + 1;
      const updated = await transaction<{ id: string }[]>`
        UPDATE ingest_jobs
        SET
          status = 'running',
          attempt_count = ${attempt},
          stage = 'upload',
          progress = 5,
          error_json = NULL,
          started_at = now(),
          finished_at = NULL
        WHERE
          id = ${event.data.ingestJobId}::uuid
          AND tenant_id = ${event.tenantId}::uuid
          AND attempt_count = ${row.attemptCount}
        RETURNING id
      `;
      if (updated.length !== 1) throw leaseLost();
      return {
        kind: 'claimed',
        value: Object.freeze({ attempt, source: toSource(row, event.tenantId) }),
      } as const;
    });
  }

  public async markStage(
    event: ValidatedKnowledgeIngestEvent,
    claim: IngestClaim,
    stage: IngestStage,
    progress: number,
  ): Promise<void> {
    if (!Number.isInteger(progress) || progress < 1 || progress > 99) {
      throw new TypeError('Ingest progress is invalid');
    }
    const rows = await this.client<{ id: string }[]>`
      UPDATE ingest_jobs
      SET stage = ${stage}, progress = ${progress}
      WHERE
        id = ${event.data.ingestJobId}::uuid
        AND tenant_id = ${event.tenantId}::uuid
        AND source_document_id = ${claim.source.id}::uuid
        AND status = 'running'
        AND attempt_count = ${claim.attempt}
      RETURNING id
    `;
    if (rows.length !== 1) throw leaseLost();
  }

  public async heartbeat(event: ValidatedKnowledgeIngestEvent, claim: IngestClaim): Promise<void> {
    const rows = await this.client<{ id: string }[]>`
      UPDATE ingest_jobs
      SET updated_at = now()
      WHERE
        id = ${event.data.ingestJobId}::uuid
        AND tenant_id = ${event.tenantId}::uuid
        AND source_document_id = ${claim.source.id}::uuid
        AND status = 'running'
        AND attempt_count = ${claim.attempt}
      RETURNING id
    `;
    if (rows.length !== 1) throw leaseLost();
  }

  public async saveChunks(
    event: ValidatedKnowledgeIngestEvent,
    claim: IngestClaim,
    chunks: readonly SourceChunkDraft[],
  ): Promise<void> {
    validateChunks(chunks);
    await this.client.begin(async (transaction) => {
      await requireLease(transaction, event, claim);
      const existing = await transaction<ExistingChunkRow[]>`
        SELECT
          chunk_no AS "chunkNo",
          metadata_json AS metadata,
          status,
          text,
          text_hash AS "textHash",
          token_count AS "tokenCount"
        FROM source_chunks
        WHERE
          tenant_id = ${event.tenantId}::uuid
          AND source_document_id = ${claim.source.id}::uuid
        ORDER BY chunk_no
        FOR UPDATE
      `;
      if (existing.length > 0) {
        if (existing.length !== chunks.length || !chunksMatch(existing, chunks)) {
          throw new IngestWorkerError(
            'CHUNK_PROVENANCE_CONFLICT',
            'Existing chunks differ from deterministic ingestion output',
            { retryable: false },
          );
        }
        await transaction`
          UPDATE source_chunks
          SET status = 'active'
          WHERE
            tenant_id = ${event.tenantId}::uuid
            AND source_document_id = ${claim.source.id}::uuid
            AND status = 'inactive'
        `;
        return;
      }
      for (const chunk of chunks) {
        await transaction`
          INSERT INTO source_chunks (
            tenant_id,
            source_document_id,
            chunk_no,
            text,
            text_hash,
            metadata_json,
            token_count
          ) VALUES (
            ${event.tenantId}::uuid,
            ${claim.source.id}::uuid,
            ${chunk.chunkNo},
            ${chunk.text},
            ${chunk.textHash},
            ${JSON.stringify(chunk.metadata)}::text::jsonb,
            ${chunk.tokenCount}
          )
        `;
      }
    });
  }

  public async succeed(
    event: ValidatedKnowledgeIngestEvent,
    claim: IngestClaim,
    modelKey: string,
  ): Promise<void> {
    await this.client.begin(async (transaction) => {
      await requireLease(transaction, event, claim);
      const verification = await transaction<
        { chunks: number; missingEmbeddings: number; missingSearch: number }[]
      >`
        SELECT
          count(*)::integer AS chunks,
          count(*) FILTER (WHERE chunk.search_vector IS NULL)::integer AS "missingSearch",
          count(*) FILTER (WHERE embedding.id IS NULL)::integer AS "missingEmbeddings"
        FROM source_chunks AS chunk
        LEFT JOIN embeddings AS embedding
          ON embedding.tenant_id = chunk.tenant_id
          AND embedding.chunk_id = chunk.id
          AND embedding.model_key = ${modelKey}
        WHERE
          chunk.tenant_id = ${event.tenantId}::uuid
          AND chunk.source_document_id = ${claim.source.id}::uuid
          AND chunk.status = 'active'
      `;
      const checked = verification[0];
      if (
        !checked ||
        checked.chunks < 1 ||
        checked.missingEmbeddings !== 0 ||
        checked.missingSearch !== 0
      ) {
        throw new IngestWorkerError('INDEX_INCOMPLETE', 'Knowledge index is incomplete', {
          retryable: true,
        });
      }
      const completed = await transaction<{ id: string }[]>`
        UPDATE ingest_jobs
        SET
          status = 'succeeded',
          stage = 'done',
          progress = 100,
          error_json = NULL,
          finished_at = now()
        WHERE
          id = ${event.data.ingestJobId}::uuid
          AND tenant_id = ${event.tenantId}::uuid
          AND status = 'running'
          AND attempt_count = ${claim.attempt}
        RETURNING id
      `;
      if (completed.length !== 1) throw leaseLost();
      await transaction`
        UPDATE source_documents
        SET status = 'active'
        WHERE
          id = ${claim.source.id}::uuid
          AND tenant_id = ${event.tenantId}::uuid
          AND deleted_at IS NULL
          AND status IN ('processing', 'active')
      `;
    });
  }

  public async fail(
    event: ValidatedKnowledgeIngestEvent,
    claim: IngestClaim,
    error: Error,
  ): Promise<void> {
    const ingestError = asIngestError(error);
    const retryable = ingestError.retryable && claim.attempt < this.maxAttempts;
    const errorJson = JSON.stringify({
      code: ingestError.code,
      message: ingestError.message.slice(0, 2_000),
      retryable,
      schema_version: 'job-error@1',
    });
    await this.client.begin(async (transaction) => {
      const rows = retryable
        ? await transaction<{ id: string }[]>`
            UPDATE ingest_jobs
            SET
              status = 'queued',
              stage = 'queued',
              progress = 0,
              error_json = ${errorJson}::text::jsonb,
              started_at = NULL,
              finished_at = NULL
            WHERE
              id = ${event.data.ingestJobId}::uuid
              AND tenant_id = ${event.tenantId}::uuid
              AND status = 'running'
              AND attempt_count = ${claim.attempt}
            RETURNING id
          `
        : await transaction<{ id: string }[]>`
            UPDATE ingest_jobs
            SET
              status = 'failed',
              error_json = ${errorJson}::text::jsonb,
              finished_at = now()
            WHERE
              id = ${event.data.ingestJobId}::uuid
              AND tenant_id = ${event.tenantId}::uuid
              AND status = 'running'
              AND attempt_count = ${claim.attempt}
            RETURNING id
          `;
      if (rows.length === 1 && !retryable) {
        await transaction`
          UPDATE source_documents
          SET status = 'failed'
          WHERE
            id = ${claim.source.id}::uuid
            AND tenant_id = ${event.tenantId}::uuid
            AND deleted_at IS NULL
            AND status IN ('processing', 'active')
        `;
      }
    });
  }
}

function toSource(row: ClaimRow, tenantId: string): IngestSource {
  return Object.freeze({
    contentHash: row.contentHash,
    id: row.id,
    language: row.language,
    mimeType: row.mimeType,
    sourceType: row.sourceType as IngestSource['sourceType'],
    status: row.sourceStatus as IngestSource['status'],
    tenantId,
    title: row.title,
    workspaceId: row.workspaceId,
  });
}

async function requireLease(
  transaction: postgres.TransactionSql,
  event: ValidatedKnowledgeIngestEvent,
  claim: IngestClaim,
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    SELECT id
    FROM ingest_jobs
    WHERE
      id = ${event.data.ingestJobId}::uuid
      AND tenant_id = ${event.tenantId}::uuid
      AND source_document_id = ${claim.source.id}::uuid
      AND status = 'running'
      AND attempt_count = ${claim.attempt}
    FOR UPDATE
  `;
  if (rows.length !== 1) throw leaseLost();
}

function validateChunks(chunks: readonly SourceChunkDraft[]): void {
  if (chunks.length < 1 || chunks.length > 100_000) {
    throw new IngestWorkerError('CHUNK_OUTPUT_INVALID', 'Chunk output count is invalid', {
      retryable: false,
    });
  }
  for (const [index, chunk] of chunks.entries()) {
    if (
      chunk.chunkNo !== index ||
      !chunk.text.trim() ||
      !/^[0-9a-f]{64}$/u.test(chunk.textHash) ||
      !Number.isSafeInteger(chunk.tokenCount) ||
      chunk.tokenCount < 1 ||
      chunk.tokenCount > 900 ||
      typeof chunk.metadata !== 'object' ||
      chunk.metadata === null ||
      (chunk.metadata as { readonly schema_version?: unknown }).schema_version !==
        'chunk-metadata@1'
    ) {
      throw new IngestWorkerError('CHUNK_OUTPUT_INVALID', 'Chunk output is invalid', {
        retryable: false,
      });
    }
  }
}

function chunksMatch(existing: readonly ExistingChunkRow[], chunks: readonly SourceChunkDraft[]) {
  return existing.every((row, index) => {
    const draft = chunks[index];
    return (
      draft !== undefined &&
      row.chunkNo === draft.chunkNo &&
      row.text === draft.text &&
      row.textHash === draft.textHash &&
      row.tokenCount === draft.tokenCount &&
      canonicalJson(row.metadata) === canonicalJson(draft.metadata)
    );
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function leaseLost(): IngestWorkerError {
  return new IngestWorkerError('INGEST_LEASE_LOST', 'Knowledge ingest lease was lost', {
    retryable: true,
  });
}
