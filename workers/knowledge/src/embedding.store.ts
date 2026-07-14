import { createHash } from 'node:crypto';

import { EMBEDDING_DIMENSION, type EmbeddingVector } from '@geo-content-os/adapter-embedding';
import type postgres from 'postgres';

export interface EmbeddingChunk {
  readonly id: string;
  readonly text: string;
  readonly textHash: string;
}

export interface EmbeddingStorePort {
  findMissing(
    tenantId: string,
    sourceDocumentId: string,
    modelKey: string,
    limit: number,
  ): Promise<readonly EmbeddingChunk[]>;
  save(
    tenantId: string,
    sourceDocumentId: string,
    modelKey: string,
    textHash: string,
    embedding: EmbeddingVector,
  ): Promise<boolean>;
}

export class EmbeddingStore implements EmbeddingStorePort {
  public constructor(private readonly client: postgres.Sql) {}

  public async findMissing(
    tenantId: string,
    sourceDocumentId: string,
    modelKey: string,
    limit: number,
  ): Promise<readonly EmbeddingChunk[]> {
    return this.client<EmbeddingChunk[]>`
      SELECT chunk.id, chunk.text, chunk.text_hash AS "textHash"
      FROM source_chunks AS chunk
      JOIN source_documents AS source
        ON source.id = chunk.source_document_id
        AND source.tenant_id = chunk.tenant_id
      LEFT JOIN embeddings AS embedding
        ON embedding.tenant_id = chunk.tenant_id
        AND embedding.chunk_id = chunk.id
        AND embedding.model_key = ${modelKey}
      WHERE
        chunk.tenant_id = ${tenantId}::uuid
        AND chunk.source_document_id = ${sourceDocumentId}::uuid
        AND chunk.status = 'active'
        AND source.deleted_at IS NULL
        AND source.status IN ('processing', 'active')
        AND embedding.id IS NULL
      ORDER BY chunk.chunk_no, chunk.id
      LIMIT ${limit}
    `;
  }

  public async save(
    tenantId: string,
    sourceDocumentId: string,
    modelKey: string,
    textHash: string,
    embedding: EmbeddingVector,
  ): Promise<boolean> {
    validateVector(embedding.vector);
    const literal = `[${embedding.vector.join(',')}]`;
    const rows = await this.client<{ id: string }[]>`
      INSERT INTO embeddings (tenant_id, chunk_id, model_key, dimension, embedding)
      SELECT
        chunk.tenant_id,
        chunk.id,
        ${modelKey},
        ${EMBEDDING_DIMENSION},
        ${literal}::vector
      FROM source_chunks AS chunk
      JOIN source_documents AS source
        ON source.id = chunk.source_document_id
        AND source.tenant_id = chunk.tenant_id
      WHERE
        chunk.id = ${embedding.id}::uuid
        AND chunk.tenant_id = ${tenantId}::uuid
        AND chunk.source_document_id = ${sourceDocumentId}::uuid
        AND chunk.text_hash = ${textHash}
        AND encode(digest(chunk.text, 'sha256'), 'hex') = chunk.text_hash
        AND chunk.status = 'active'
        AND source.deleted_at IS NULL
        AND source.status IN ('processing', 'active')
      ON CONFLICT (tenant_id, chunk_id, model_key) DO NOTHING
      RETURNING id
    `;
    return rows.length === 1;
  }
}

export function assertChunkHash(chunk: EmbeddingChunk): void {
  if (createHash('sha256').update(chunk.text).digest('hex') !== chunk.textHash) {
    throw new Error(`Chunk ${chunk.id} text hash does not match`);
  }
}

function validateVector(vector: readonly number[]): void {
  if (
    vector.length !== EMBEDDING_DIMENSION ||
    vector.some((value) => !Number.isFinite(value)) ||
    vector.every((value) => value === 0)
  ) {
    throw new TypeError('Embedding vector must contain 1536 finite non-zero dimensions');
  }
}
