import type { DatabaseClient } from '../../../database/index.js';
import type { ChunkMetadata, SourceTrustLevel } from '../../../database/schema/index.js';

export interface FtsSearchScope {
  readonly projectId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

export interface FtsSearchOptions {
  readonly effectiveOn?: string;
  readonly limit?: number;
  readonly trustLevels?: readonly SourceTrustLevel[];
}

export interface FtsSearchHit {
  readonly chunkId: string;
  readonly chunkNo: number;
  readonly metadata: ChunkMetadata;
  readonly rank: number;
  readonly sourceDocumentId: string;
  readonly sourceTitle: string;
  readonly text: string;
  readonly textHash: string;
  readonly tokenCount: number;
  readonly trustLevel: SourceTrustLevel;
}

const TRUST_LEVELS = new Set<SourceTrustLevel>(['normal', 'untrusted', 'verified']);

export class FtsRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async search(
    scope: FtsSearchScope,
    rawQuery: string,
    options: FtsSearchOptions = {},
  ): Promise<readonly FtsSearchHit[]> {
    const query = rawQuery.normalize('NFC').trim().replace(/\s+/gu, ' ');
    if (!query || query.length > 500)
      throw new TypeError('FTS query must contain 1 to 500 characters');
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('FTS result limit must be an integer between 1 and 100');
    }
    const effectiveOn = options.effectiveOn ?? new Date().toISOString().slice(0, 10);
    if (!isIsoDate(effectiveOn))
      throw new TypeError('FTS effective date must be an ISO calendar date');
    const trustLevels = [...(options.trustLevels ?? ['verified', 'normal'])];
    if (
      trustLevels.length === 0 ||
      trustLevels.length > TRUST_LEVELS.size ||
      trustLevels.some((value) => !TRUST_LEVELS.has(value)) ||
      new Set(trustLevels).size !== trustLevels.length
    ) {
      throw new TypeError('FTS trust levels are invalid');
    }

    return this.client<FtsSearchHit[]>`
      WITH fts_query AS (
        SELECT websearch_to_tsquery('simple', ${query}) AS value
      )
      SELECT
        chunk.id AS "chunkId",
        chunk.source_document_id AS "sourceDocumentId",
        chunk.chunk_no AS "chunkNo",
        chunk.text,
        chunk.text_hash AS "textHash",
        chunk.metadata_json AS metadata,
        chunk.token_count AS "tokenCount",
        source.title AS "sourceTitle",
        source.trust_level AS "trustLevel",
        ts_rank_cd(chunk.search_vector, fts_query.value, 32)::double precision AS rank
      FROM source_chunks AS chunk
      JOIN source_documents AS source
        ON source.id = chunk.source_document_id
        AND source.tenant_id = chunk.tenant_id
      JOIN workspaces AS workspace
        ON workspace.id = source.workspace_id
        AND workspace.tenant_id = source.tenant_id
      JOIN projects AS project_context
        ON project_context.id = ${scope.projectId}
        AND project_context.tenant_id = source.tenant_id
        AND project_context.workspace_id = source.workspace_id
        AND project_context.deleted_at IS NULL
      CROSS JOIN fts_query
      WHERE
        chunk.tenant_id = ${scope.tenantId}
        AND source.workspace_id = ${scope.workspaceId}
        AND (source.project_id IS NULL OR source.project_id = ${scope.projectId})
        AND source.deleted_at IS NULL
        AND workspace.deleted_at IS NULL
        AND source.status = 'active'
        AND chunk.status = 'active'
        AND source.trust_level = ANY(${this.client.array(trustLevels)}::varchar[])
        AND (source.effective_from IS NULL OR source.effective_from <= ${effectiveOn}::date)
        AND (source.effective_to IS NULL OR source.effective_to >= ${effectiveOn}::date)
        AND has_project_scope_access(
          source.tenant_id,
          source.workspace_id,
          ${scope.projectId},
          ${scope.userId}
        )
        AND numnode(fts_query.value) > 0
        AND chunk.search_vector @@ fts_query.value
      ORDER BY rank DESC, chunk.id
      LIMIT ${limit}
    `;
  }
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
