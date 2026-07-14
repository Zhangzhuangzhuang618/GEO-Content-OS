import { createHash } from 'node:crypto';

import {
  MockEmbeddingProvider,
  ProviderEmbeddingAdapter,
  type EmbeddingConfiguration,
  type EmbeddingVector,
} from '@geo-content-os/adapter-embedding';
import { describe, expect, it } from 'vitest';

import type { EmbeddingCache } from './embedding.cache.js';
import type { EmbeddingChunk, EmbeddingStorePort } from './embedding.store.js';
import { EmbeddingWorker } from './embedding.worker.js';

const configuration: EmbeddingConfiguration = {
  driver: 'mock',
  maxBatchSize: 4,
  maxInputCharacters: 10_000,
  modelKey: 'embedding-worker-test-v1',
  timeoutMs: 1_000,
};

describe('EmbeddingWorker', () => {
  it('deduplicates equal text in a batch and degrades when cache is unavailable', async () => {
    const duplicateText = 'same evidence';
    const chunks = [
      chunk('61000000-0000-4000-8000-000000000001', duplicateText),
      chunk('61000000-0000-4000-8000-000000000002', duplicateText),
      chunk('61000000-0000-4000-8000-000000000003', 'different evidence'),
    ];
    const store = new FakeStore(chunks);
    const worker = new EmbeddingWorker(
      store,
      new FailingCache(),
      new ProviderEmbeddingAdapter(configuration, new MockEmbeddingProvider()),
    );

    const result = await worker.run({
      requestId: 'req-embedding-worker-unit-0001',
      sourceDocumentId: '51000000-0000-4000-8000-000000000001',
      tenantId: '21000000-0000-4000-8000-000000000001',
    });

    expect(result).toMatchObject({ cacheHits: 0, embedded: 3, providerCalls: 1, selected: 3 });
    expect(result.usage[0]?.inputCount).toBe(2);
    expect(store.saved.map((entry) => entry.id).sort()).toEqual(
      chunks.map((entry) => entry.id).sort(),
    );
  });

  it('rejects malformed queue identities before reading storage', async () => {
    const store = new FakeStore([]);
    const worker = new EmbeddingWorker(
      store,
      new FailingCache(),
      new ProviderEmbeddingAdapter(configuration, new MockEmbeddingProvider()),
    );
    await expect(
      worker.run({ requestId: 'short', sourceDocumentId: 'bad', tenantId: 'bad' }),
    ).rejects.toThrow(TypeError);
    expect(store.reads).toBe(0);
  });
});

class FakeStore implements EmbeddingStorePort {
  public reads = 0;
  public readonly saved: EmbeddingVector[] = [];
  public constructor(private readonly chunks: readonly EmbeddingChunk[]) {}
  public async findMissing() {
    this.reads += 1;
    return this.chunks;
  }
  public async save(
    _tenantId: string,
    _sourceDocumentId: string,
    _modelKey: string,
    _textHash: string,
    embedding: EmbeddingVector,
  ) {
    this.saved.push(embedding);
    return true;
  }
}

class FailingCache implements EmbeddingCache {
  public getMany(): Promise<ReadonlyMap<string, readonly number[]>> {
    return Promise.reject(new Error('Redis unavailable'));
  }
  public setMany(): Promise<void> {
    return Promise.reject(new Error('Redis unavailable'));
  }
}

function chunk(id: string, text: string): EmbeddingChunk {
  return { id, text, textHash: createHash('sha256').update(text).digest('hex') };
}
