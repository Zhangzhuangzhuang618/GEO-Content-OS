import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ProviderEmbeddingAdapter, createEmbeddingAdapter } from './embedding.adapter.js';
import { EmbeddingAdapterError } from './embedding.errors.js';
import { MockEmbeddingProvider } from './mock-embedding.provider.js';
import type { EmbeddingConfiguration, EmbeddingInput, EmbeddingProvider } from './index.js';

const configuration: EmbeddingConfiguration = {
  driver: 'mock',
  maxBatchSize: 2,
  maxInputCharacters: 1_000,
  modelKey: 'embedding-default-v1',
  timeoutMs: 500,
};

describe('Embedding Adapter', () => {
  it('returns deterministic 1536-dimensional vectors with configured model provenance', async () => {
    const adapter = new ProviderEmbeddingAdapter(configuration, new MockEmbeddingProvider());
    const inputs = [embeddingInput('chunk-1', '企业 GEO'), embeddingInput('chunk-2', 'Evidence')];

    const first = await adapter.embedBatch({ inputs, requestId: 'req-embedding-0001' });
    const second = await adapter.embedBatch({ inputs, requestId: 'req-embedding-0002' });

    expect(first.dimension).toBe(1_536);
    expect(first.embeddings).toHaveLength(2);
    expect(first.embeddings[0]?.vector).toHaveLength(1_536);
    expect(first.embeddings[0]?.vector).toEqual(second.embeddings[0]?.vector);
    expect(first.usage).toMatchObject({
      inputCount: 2,
      modelKey: 'embedding-default-v1',
      providerCode: 'mock',
      providerModelId: 'mock-embedding-1536-v1',
      status: 'settled',
    });
    expect(Object.isFrozen(first.embeddings[0]?.vector)).toBe(true);
  });

  it('rejects duplicate IDs, hash mismatches, oversize batches, and empty text', async () => {
    const adapter = new ProviderEmbeddingAdapter(configuration, new MockEmbeddingProvider());
    const valid = embeddingInput('chunk-1', 'valid');
    const invalid = [
      [valid, valid],
      [{ ...valid, textHash: '0'.repeat(64) }],
      [valid, embeddingInput('chunk-2', 'two'), embeddingInput('chunk-3', 'three')],
      [embeddingInput('chunk-empty', ' ')],
    ];
    for (const inputs of invalid) {
      await expect(
        adapter.embedBatch({ inputs, requestId: 'req-embedding-0001' }),
      ).rejects.toMatchObject({ code: 'EMBEDDING_INVALID_INPUT' });
    }
  });

  it('rejects malformed provider dimensions and ordering', async () => {
    const input = embeddingInput('chunk-1', 'valid');
    const badProviders: EmbeddingProvider[] = [
      provider(async () => ({
        embeddings: [{ id: input.id, vector: [1] }],
        inputTokens: 1,
        providerRequestId: 'provider-request-1',
      })),
      provider(async () => ({
        embeddings: [{ id: 'wrong', vector: Array(1_536).fill(1) }],
        inputTokens: 1,
        providerRequestId: 'provider-request-2',
      })),
    ];
    for (const value of badProviders) {
      const adapter = new ProviderEmbeddingAdapter(configuration, value);
      await expect(
        adapter.embedBatch({ inputs: [input], requestId: 'req-embedding-0001' }),
      ).rejects.toMatchObject({ code: 'EMBEDDING_RESPONSE_INVALID' });
    }
  });

  it('enforces total timeout and distinguishes cancellation', async () => {
    const adapter = new ProviderEmbeddingAdapter(
      { ...configuration, timeoutMs: 100 },
      new MockEmbeddingProvider({ latencyMs: 500 }),
    );
    await expect(
      adapter.embedBatch({
        inputs: [embeddingInput('chunk-1', 'timeout')],
        requestId: 'req-embedding-0001',
      }),
    ).rejects.toMatchObject({
      code: 'EMBEDDING_TIMEOUT',
      retryable: true,
      usage: { status: 'unknown' },
    });

    const controller = new AbortController();
    const request = adapter.embedBatch({
      inputs: [embeddingInput('chunk-1', 'cancel')],
      requestId: 'req-embedding-0002',
      signal: controller.signal,
    });
    controller.abort();
    await expect(request).rejects.toMatchObject({
      code: 'EMBEDDING_CANCELLED',
      retryable: false,
    });
  });

  it('fails closed when disabled', async () => {
    const adapter = createEmbeddingAdapter({ ...configuration, driver: 'disabled' });
    await expect(
      adapter.embedBatch({
        inputs: [embeddingInput('chunk-1', 'disabled')],
        requestId: 'req-embedding-0001',
      }),
    ).rejects.toBeInstanceOf(EmbeddingAdapterError);
  });
});

function embeddingInput(id: string, text: string): EmbeddingInput {
  return { id, text, textHash: createHash('sha256').update(text).digest('hex') };
}

function provider(embedBatch: EmbeddingProvider['embedBatch']): EmbeddingProvider {
  return { embedBatch, providerCode: 'test-provider', providerModelId: 'test-model' };
}
