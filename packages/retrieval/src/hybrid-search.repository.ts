import { EMBEDDING_DIMENSION } from '@geo-content-os/adapter-embedding';
import type postgres from 'postgres';

import type {
  HybridSearchHit,
  HybridSearchOptions,
  HybridSearchPort,
  HybridSearchScope,
  SearchableTrustLevel,
  ValidatedHybridSearchRequest,
} from './hybrid-search.types.js';

const SEARCHABLE_TRUST_LEVELS = new Set<SearchableTrustLevel>(['normal', 'verified']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export class HybridSearchRepository implements HybridSearchPort {
  public constructor(private readonly client: postgres.Sql | postgres.TransactionSql) {}

  public async search(
    scope: HybridSearchScope,
    rawQuery: string,
    queryEmbedding: readonly number[],
    options: HybridSearchOptions,
  ): Promise<readonly HybridSearchHit[]> {
    validateScope(scope);
    const request = validateHybridSearchRequest(rawQuery, queryEmbedding, options);

    return this.client<HybridSearchHit[]>`
      WITH fts_query AS (
        SELECT websearch_to_tsquery('simple', ${request.query}) AS value
      ),
      lexical_raw AS (
        SELECT
          chunk.id AS chunk_id,
          ts_rank_cd(chunk.search_vector, fts_query.value, 32)::double precision AS raw_score
        FROM source_chunks AS chunk
        JOIN source_documents AS source
          ON source.id = chunk.source_document_id
          AND source.tenant_id = chunk.tenant_id
        JOIN workspaces AS workspace
          ON workspace.id = source.workspace_id
          AND workspace.tenant_id = source.tenant_id
        JOIN projects AS project_context
          ON project_context.id = ${scope.projectId}::uuid
          AND project_context.tenant_id = source.tenant_id
          AND project_context.workspace_id = source.workspace_id
          AND project_context.deleted_at IS NULL
        CROSS JOIN fts_query
        WHERE
          chunk.tenant_id = ${scope.tenantId}::uuid
          AND source.workspace_id = ${scope.workspaceId}::uuid
          AND (source.project_id IS NULL OR source.project_id = ${scope.projectId}::uuid)
          AND source.deleted_at IS NULL
          AND workspace.deleted_at IS NULL
          AND source.status = 'active'
          AND (
            cardinality(${this.client.array([...request.sourceDocumentIds])}::uuid[]) = 0
            OR source.id = ANY(${this.client.array([...request.sourceDocumentIds])}::uuid[])
          )
          AND chunk.status = 'active'
          AND source.trust_level = ANY(${this.client.array([...request.trustLevels])}::varchar[])
          AND (source.effective_from IS NULL OR source.effective_from <= ${request.effectiveOn}::date)
          AND (source.effective_to IS NULL OR source.effective_to >= ${request.effectiveOn}::date)
          AND has_project_scope_access(
            source.tenant_id,
            source.workspace_id,
            ${scope.projectId}::uuid,
            ${scope.userId}::uuid
          )
          AND numnode(fts_query.value) > 0
          AND chunk.search_vector @@ fts_query.value
        ORDER BY raw_score DESC, chunk.id
        LIMIT ${request.candidateLimit}
      ),
      lexical AS (
        SELECT
          chunk_id,
          COALESCE(raw_score / NULLIF(max(raw_score) OVER (), 0), 0)::double precision AS score
        FROM lexical_raw
      ),
      vector_raw AS (
        SELECT
          chunk.id AS chunk_id,
          GREATEST(
            0,
            1 - (embedding.embedding <=> ${request.vectorLiteral}::vector)
          )::double precision AS raw_score
        FROM embeddings AS embedding
        JOIN source_chunks AS chunk
          ON chunk.id = embedding.chunk_id
          AND chunk.tenant_id = embedding.tenant_id
        JOIN source_documents AS source
          ON source.id = chunk.source_document_id
          AND source.tenant_id = chunk.tenant_id
        JOIN workspaces AS workspace
          ON workspace.id = source.workspace_id
          AND workspace.tenant_id = source.tenant_id
        JOIN projects AS project_context
          ON project_context.id = ${scope.projectId}::uuid
          AND project_context.tenant_id = source.tenant_id
          AND project_context.workspace_id = source.workspace_id
          AND project_context.deleted_at IS NULL
        WHERE
          embedding.tenant_id = ${scope.tenantId}::uuid
          AND embedding.model_key = ${request.modelKey}
          AND source.workspace_id = ${scope.workspaceId}::uuid
          AND (source.project_id IS NULL OR source.project_id = ${scope.projectId}::uuid)
          AND source.deleted_at IS NULL
          AND workspace.deleted_at IS NULL
          AND source.status = 'active'
          AND (
            cardinality(${this.client.array([...request.sourceDocumentIds])}::uuid[]) = 0
            OR source.id = ANY(${this.client.array([...request.sourceDocumentIds])}::uuid[])
          )
          AND chunk.status = 'active'
          AND source.trust_level = ANY(${this.client.array([...request.trustLevels])}::varchar[])
          AND (source.effective_from IS NULL OR source.effective_from <= ${request.effectiveOn}::date)
          AND (source.effective_to IS NULL OR source.effective_to >= ${request.effectiveOn}::date)
          AND has_project_scope_access(
            source.tenant_id,
            source.workspace_id,
            ${scope.projectId}::uuid,
            ${scope.userId}::uuid
          )
        ORDER BY embedding.embedding <=> ${request.vectorLiteral}::vector, chunk.id
        LIMIT ${request.candidateLimit}
      ),
      vector AS (
        SELECT
          chunk_id,
          COALESCE(raw_score / NULLIF(max(raw_score) OVER (), 0), 0)::double precision AS score
        FROM vector_raw
        WHERE raw_score > 0
      ),
      fused AS (
        SELECT
          COALESCE(lexical.chunk_id, vector.chunk_id) AS chunk_id,
          COALESCE(lexical.score, 0)::double precision AS fts_score,
          COALESCE(vector.score, 0)::double precision AS vector_score,
          (
            COALESCE(lexical.score, 0) * 0.5
            + COALESCE(vector.score, 0) * 0.5
          )::double precision AS fused_score,
          ARRAY_REMOVE(
            ARRAY[
              CASE WHEN lexical.chunk_id IS NOT NULL THEN 'fts' END,
              CASE WHEN vector.chunk_id IS NOT NULL THEN 'vector' END
            ],
            NULL
          )::text[] AS match_signals
        FROM lexical
        FULL OUTER JOIN vector ON vector.chunk_id = lexical.chunk_id
      )
      SELECT
        chunk.id AS "chunkId",
        chunk.source_document_id AS "sourceDocumentId",
        chunk.chunk_no AS "chunkNo",
        chunk.text,
        chunk.text_hash AS "textHash",
        chunk.metadata_json AS metadata,
        chunk.token_count AS "tokenCount",
        source.project_id AS "projectId",
        source.title AS "sourceTitle",
        source.uri AS "sourceUri",
        source.trust_level AS "trustLevel",
        fused.fts_score AS "ftsScore",
        fused.vector_score AS "vectorScore",
        fused.fused_score AS score,
        fused.match_signals AS "matchSignals"
      FROM fused
      JOIN source_chunks AS chunk ON chunk.id = fused.chunk_id
      JOIN source_documents AS source
        ON source.id = chunk.source_document_id
        AND source.tenant_id = chunk.tenant_id
      WHERE
        chunk.tenant_id = ${scope.tenantId}::uuid
        AND source.workspace_id = ${scope.workspaceId}::uuid
        AND (source.project_id IS NULL OR source.project_id = ${scope.projectId}::uuid)
        AND source.deleted_at IS NULL
        AND source.status = 'active'
        AND (
          cardinality(${this.client.array([...request.sourceDocumentIds])}::uuid[]) = 0
          OR source.id = ANY(${this.client.array([...request.sourceDocumentIds])}::uuid[])
        )
        AND chunk.status = 'active'
        AND source.trust_level = ANY(${this.client.array([...request.trustLevels])}::varchar[])
        AND (source.effective_from IS NULL OR source.effective_from <= ${request.effectiveOn}::date)
        AND (source.effective_to IS NULL OR source.effective_to >= ${request.effectiveOn}::date)
        AND has_project_scope_access(
          source.tenant_id,
          source.workspace_id,
          ${scope.projectId}::uuid,
          ${scope.userId}::uuid
        )
      ORDER BY
        fused.fused_score DESC,
        fused.fts_score DESC,
        fused.vector_score DESC,
        chunk.id
      LIMIT ${request.topK}
    `;
  }
}

export function validateHybridSearchRequest(
  rawQuery: string,
  queryEmbedding: readonly number[],
  options: HybridSearchOptions,
): ValidatedHybridSearchRequest {
  const query = rawQuery.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (query.length < 2 || query.length > 500) {
    throw new TypeError('Hybrid search query must contain 2 to 500 characters');
  }
  const vector = queryEmbedding.map((value) => Math.fround(value));
  if (
    vector.length !== EMBEDDING_DIMENSION ||
    vector.some((value) => !Number.isFinite(value)) ||
    vector.every((value) => value === 0)
  ) {
    throw new TypeError('Hybrid search query embedding must have 1536 finite dimensions');
  }
  if (!IDENTIFIER.test(options.modelKey)) throw new TypeError('Hybrid search model key is invalid');
  const topK = options.topK ?? 10;
  if (!Number.isSafeInteger(topK) || topK < 1 || topK > 20) {
    throw new TypeError('Hybrid search topK must be an integer between 1 and 20');
  }
  const candidateLimit = options.candidateLimit ?? 20;
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < topK || candidateLimit > 100) {
    throw new TypeError('Hybrid search candidate limit must be between topK and 100');
  }
  const effectiveOn = options.effectiveOn ?? new Date().toISOString().slice(0, 10);
  if (!isIsoDate(effectiveOn)) throw new TypeError('Hybrid search effective date is invalid');
  const trustLevels = [...(options.trustLevels ?? ['verified', 'normal'])];
  const sourceDocumentIds = [...(options.sourceDocumentIds ?? [])];
  if (
    trustLevels.length === 0 ||
    trustLevels.length > SEARCHABLE_TRUST_LEVELS.size ||
    trustLevels.some((level) => !SEARCHABLE_TRUST_LEVELS.has(level)) ||
    new Set(trustLevels).size !== trustLevels.length
  ) {
    throw new TypeError('Hybrid search trust levels are invalid');
  }
  if (
    sourceDocumentIds.length > 100 ||
    sourceDocumentIds.some((id) => !UUID.test(id)) ||
    new Set(sourceDocumentIds).size !== sourceDocumentIds.length
  ) {
    throw new TypeError('Hybrid search source document scope is invalid');
  }
  return Object.freeze({
    candidateLimit,
    effectiveOn,
    modelKey: options.modelKey,
    query,
    sourceDocumentIds: Object.freeze(sourceDocumentIds),
    topK,
    trustLevels: Object.freeze(trustLevels),
    vectorLiteral: `[${vector.join(',')}]`,
  });
}

function validateScope(scope: HybridSearchScope): void {
  if (
    !UUID.test(scope.tenantId) ||
    !UUID.test(scope.workspaceId) ||
    !UUID.test(scope.projectId) ||
    !UUID.test(scope.userId)
  ) {
    throw new TypeError('Hybrid search scope must contain UUIDs');
  }
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
