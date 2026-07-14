import { createHash } from 'node:crypto';

import type { EmbeddingAdapter, EmbeddingUsage } from '@geo-content-os/adapter-embedding';

import type { EmbeddingCache } from './embedding.cache.js';
import {
  assertChunkHash,
  type EmbeddingChunk,
  type EmbeddingStorePort,
} from './embedding.store.js';

export interface EmbedSourceInput {
  readonly requestId: string;
  readonly signal?: AbortSignal;
  readonly sourceDocumentId: string;
  readonly tenantId: string;
}

export interface EmbedSourceResult {
  readonly cacheHits: number;
  readonly embedded: number;
  readonly modelKey: string;
  readonly providerCalls: number;
  readonly selected: number;
  readonly usage: readonly EmbeddingUsage[];
}

export class EmbeddingWorker {
  public constructor(
    private readonly store: EmbeddingStorePort,
    private readonly cache: EmbeddingCache,
    private readonly adapter: EmbeddingAdapter,
    private readonly maxChunksPerRun = 100_000,
  ) {
    if (
      !Number.isSafeInteger(maxChunksPerRun) ||
      maxChunksPerRun < 1 ||
      maxChunksPerRun > 100_000
    ) {
      throw new TypeError('Embedding worker chunk limit is invalid');
    }
  }

  public async run(input: EmbedSourceInput): Promise<EmbedSourceResult> {
    validateInput(input);
    const chunks = await this.store.findMissing(
      input.tenantId,
      input.sourceDocumentId,
      this.adapter.modelKey,
      this.maxChunksPerRun,
    );
    chunks.forEach(assertChunkHash);
    let cached: ReadonlyMap<string, readonly number[]> = new Map();
    try {
      cached = await this.cache.getMany(
        input.tenantId,
        this.adapter.modelKey,
        chunks.map((chunk) => chunk.textHash),
      );
    } catch {
      // Cache is an optimization. PostgreSQL and the provider remain authoritative.
    }
    let cacheHits = 0;
    let embedded = 0;
    let providerCalls = 0;
    const usage: EmbeddingUsage[] = [];
    const misses: EmbeddingChunk[] = [];

    for (const chunk of chunks) {
      const vector = cached.get(chunk.textHash);
      if (!vector) {
        misses.push(chunk);
        continue;
      }
      cacheHits += 1;
      if (
        await this.store.save(
          input.tenantId,
          input.sourceDocumentId,
          this.adapter.modelKey,
          chunk.textHash,
          { id: chunk.id, vector },
        )
      ) {
        embedded += 1;
      }
    }

    const missesByHash = new Map<string, EmbeddingChunk[]>();
    for (const chunk of misses) {
      const group = missesByHash.get(chunk.textHash);
      if (group) group.push(chunk);
      else missesByHash.set(chunk.textHash, [chunk]);
    }
    const uniqueMisses = [...missesByHash.values()].map((group) => group[0]!);
    for (let offset = 0; offset < uniqueMisses.length; offset += this.adapter.maxBatchSize) {
      const batch = uniqueMisses.slice(offset, offset + this.adapter.maxBatchSize);
      const result = await this.adapter.embedBatch({
        inputs: batch.map((chunk) => ({
          id: chunk.id,
          text: chunk.text,
          textHash: chunk.textHash,
        })),
        requestId: batchRequestId(input.requestId, Math.floor(offset / this.adapter.maxBatchSize)),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      providerCalls += 1;
      usage.push(result.usage);
      for (const item of result.embeddings) {
        const representative = batch.find((candidate) => candidate.id === item.id);
        if (!representative) throw new Error('Embedding Adapter returned an unknown chunk');
        for (const chunk of missesByHash.get(representative.textHash) ?? []) {
          if (
            await this.store.save(
              input.tenantId,
              input.sourceDocumentId,
              this.adapter.modelKey,
              chunk.textHash,
              { id: chunk.id, vector: item.vector },
            )
          ) {
            embedded += 1;
          }
        }
      }
      try {
        await this.cache.setMany(
          input.tenantId,
          this.adapter.modelKey,
          result.embeddings.map((item) => ({
            textHash: batch.find((chunk) => chunk.id === item.id)!.textHash,
            vector: item.vector,
          })),
        );
      } catch {
        // A cache write failure must not roll back durable embeddings.
      }
    }

    return Object.freeze({
      cacheHits,
      embedded,
      modelKey: this.adapter.modelKey,
      providerCalls,
      selected: chunks.length,
      usage: Object.freeze(usage),
    });
  }
}

function validateInput(input: EmbedSourceInput): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (!uuid.test(input.tenantId) || !uuid.test(input.sourceDocumentId)) {
    throw new TypeError('Embedding worker tenant and source IDs must be UUIDs');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,79}$/u.test(input.requestId)) {
    throw new TypeError('Embedding worker request ID is invalid');
  }
}

function batchRequestId(requestId: string, batch: number): string {
  return `embed-${createHash('sha256').update(`${requestId}:${batch}`).digest('hex')}`;
}
