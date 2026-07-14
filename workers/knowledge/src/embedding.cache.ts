import { createHash } from 'node:crypto';

import { EMBEDDING_DIMENSION } from '@geo-content-os/adapter-embedding';
import type { Redis } from 'ioredis';

export interface EmbeddingCacheEntry {
  readonly textHash: string;
  readonly vector: readonly number[];
}

export interface EmbeddingCache {
  getMany(
    tenantId: string,
    modelKey: string,
    textHashes: readonly string[],
  ): Promise<ReadonlyMap<string, readonly number[]>>;
  setMany(
    tenantId: string,
    modelKey: string,
    entries: readonly EmbeddingCacheEntry[],
  ): Promise<void>;
}

export class RedisEmbeddingCache implements EmbeddingCache {
  public constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds = 604_800,
  ) {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 2_592_000) {
      throw new TypeError('Embedding cache TTL must be between 60 and 2592000 seconds');
    }
  }

  public async getMany(
    tenantId: string,
    modelKey: string,
    textHashes: readonly string[],
  ): Promise<ReadonlyMap<string, readonly number[]>> {
    if (textHashes.length === 0) return new Map();
    const values = await this.redis.mget(textHashes.map((hash) => key(tenantId, modelKey, hash)));
    const result = new Map<string, readonly number[]>();
    values.forEach((value, index) => {
      if (!value) return;
      try {
        const vector: unknown = JSON.parse(value);
        if (validVector(vector)) result.set(textHashes[index]!, Object.freeze(vector));
      } catch {
        // Corrupt cache values are misses; PostgreSQL remains authoritative.
      }
    });
    return result;
  }

  public async setMany(
    tenantId: string,
    modelKey: string,
    entries: readonly EmbeddingCacheEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const transaction = this.redis.multi();
    for (const entry of entries) {
      if (!validVector(entry.vector))
        throw new TypeError('Cannot cache an invalid embedding vector');
      transaction.set(
        key(tenantId, modelKey, entry.textHash),
        JSON.stringify(entry.vector),
        'EX',
        this.ttlSeconds,
      );
    }
    await transaction.exec();
  }
}

export class InMemoryEmbeddingCache implements EmbeddingCache {
  private readonly values = new Map<string, readonly number[]>();
  public async getMany(tenantId: string, modelKey: string, hashes: readonly string[]) {
    const result = new Map<string, readonly number[]>();
    for (const hash of hashes) {
      const value = this.values.get(key(tenantId, modelKey, hash));
      if (value) result.set(hash, value);
    }
    return result;
  }
  public async setMany(
    tenantId: string,
    modelKey: string,
    entries: readonly EmbeddingCacheEntry[],
  ) {
    for (const entry of entries) {
      this.values.set(key(tenantId, modelKey, entry.textHash), Object.freeze([...entry.vector]));
    }
  }
}

function key(tenantId: string, modelKey: string, textHash: string): string {
  const modelHash = createHash('sha256').update(modelKey).digest('hex').slice(0, 24);
  return `embedding:v1:${tenantId}:${modelHash}:${textHash}`;
}

function validVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === EMBEDDING_DIMENSION &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item)) &&
    value.some((item) => item !== 0)
  );
}
