import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { MockRerankProvider } from './mock-rerank.provider.js';
import { ProviderRerankAdapter, createRerankAdapter } from './rerank.adapter.js';
import type { RerankConfiguration } from './rerank.config.js';
import type { RerankDocument, RerankProvider } from './rerank.types.js';

const configuration: RerankConfiguration = {
  driver: 'mock',
  maxDocuments: 20,
  maxInputCharacters: 100_000,
  modelKey: 'rerank-test-v1',
  timeoutMs: 500,
};

describe('Rerank Adapter', () => {
  it('returns stable relevance order, immutable scores, and provider provenance', async () => {
    const adapter = new ProviderRerankAdapter(configuration, new MockRerankProvider());
    const documents = [
      document('doc-1', 'unrelated material'),
      document('doc-2', 'enterprise GEO'),
    ];
    const result = await adapter.rerank({
      documents,
      query: 'enterprise GEO',
      requestId: 'req-rerank-adapter-0001',
      topK: 2,
    });

    expect(result.items.map((item) => item.id)).toEqual(['doc-2', 'doc-1']);
    expect(result.usage).toMatchObject({
      inputDocuments: 2,
      modelKey: 'rerank-test-v1',
      providerCode: 'mock',
      providerModelId: 'mock-rerank-v1',
      status: 'settled',
    });
    expect(Object.isFrozen(result.items)).toBe(true);
  });

  it('rejects duplicates, text-hash mismatches, invalid topK, and oversize input', async () => {
    const adapter = new ProviderRerankAdapter(
      { ...configuration, maxInputCharacters: 30 },
      new MockRerankProvider(),
    );
    const valid = document('doc-1', 'valid text');
    const invalid = [
      { documents: [valid, valid], topK: 1 },
      { documents: [{ ...valid, textHash: '0'.repeat(64) }], topK: 1 },
      { documents: [valid], topK: 2 },
      { documents: [document('doc-2', 'x'.repeat(40))], topK: 1 },
    ];
    for (const input of invalid) {
      await expect(
        adapter.rerank({
          ...input,
          query: 'valid query',
          requestId: 'req-rerank-adapter-0002',
        }),
      ).rejects.toMatchObject({ code: 'RERANK_INVALID_INPUT' });
    }
  });

  it('rejects missing, duplicate, unknown, and out-of-range provider scores', async () => {
    const documents = [document('doc-1', 'one'), document('doc-2', 'two')];
    const invalidItems = [
      [{ id: 'doc-1', score: 1 }],
      [
        { id: 'doc-1', score: 1 },
        { id: 'doc-1', score: 0 },
      ],
      [
        { id: 'doc-1', score: 1 },
        { id: 'unknown', score: 0 },
      ],
      [
        { id: 'doc-1', score: 2 },
        { id: 'doc-2', score: 0 },
      ],
    ];
    for (const items of invalidItems) {
      const adapter = new ProviderRerankAdapter(configuration, provider(items));
      await expect(
        adapter.rerank({
          documents,
          query: 'valid query',
          requestId: 'req-rerank-adapter-0003',
          topK: 2,
        }),
      ).rejects.toMatchObject({ code: 'RERANK_RESPONSE_INVALID' });
    }
  });

  it('enforces timeout and distinguishes caller cancellation', async () => {
    const adapter = new ProviderRerankAdapter(
      { ...configuration, timeoutMs: 100 },
      new MockRerankProvider({ latencyMs: 500 }),
    );
    const input = {
      documents: [document('doc-1', 'evidence')],
      query: 'evidence',
      requestId: 'req-rerank-adapter-0004',
      topK: 1,
    } as const;
    await expect(adapter.rerank(input)).rejects.toMatchObject({
      code: 'RERANK_TIMEOUT',
      retryable: true,
      usage: { status: 'unknown' },
    });

    const controller = new AbortController();
    const request = adapter.rerank({ ...input, signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: 'RERANK_CANCELLED', retryable: false });
  });

  it('fails closed when disabled', async () => {
    const adapter = createRerankAdapter({ ...configuration, driver: 'disabled' });
    await expect(
      adapter.rerank({
        documents: [document('doc-1', 'evidence')],
        query: 'evidence',
        requestId: 'req-rerank-adapter-0005',
        topK: 1,
      }),
    ).rejects.toMatchObject({ code: 'RERANK_UNAVAILABLE' });
  });
});

function document(id: string, text: string): RerankDocument {
  return { id, text, textHash: createHash('sha256').update(text).digest('hex') };
}

function provider(items: readonly Readonly<{ id: string; score: number }>[]): RerankProvider {
  return {
    providerCode: 'test-provider',
    providerModelId: 'test-model',
    rerank: async () => ({ inputTokens: 1, items, providerRequestId: 'provider-request-1' }),
  };
}
