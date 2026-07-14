import { createHash } from 'node:crypto';

import {
  MockRerankProvider,
  ProviderRerankAdapter,
  RerankAdapterError,
  type RerankAdapter,
  type RerankInput,
  type RerankResult,
} from '@geo-content-os/adapter-rerank';
import { describe, expect, it } from 'vitest';

import { CitationSearchService, diversify } from './citation-search.service.js';
import type {
  HybridSearchHit,
  HybridSearchOptions,
  HybridSearchPort,
  HybridSearchScope,
} from './hybrid-search.types.js';

const SCOPE: HybridSearchScope = {
  projectId: '43000000-0000-4000-8000-000000000037',
  tenantId: '23000000-0000-4000-8000-000000000037',
  userId: '13000000-0000-4000-8000-000000000037',
  workspaceId: '33000000-0000-4000-8000-000000000037',
};
const VECTOR = Object.freeze([1, ...Array<number>(1_535).fill(0)]);
const configuration = {
  driver: 'mock',
  maxDocuments: 20,
  maxInputCharacters: 200_000,
  modelKey: 'rerank-search-test-v1',
  timeoutMs: 1_000,
} as const;

describe('CitationSearchService', () => {
  it('uses the frozen 20 -> 8 -> 5 policy and returns stable reranked citation context', async () => {
    const search = new FakeHybridSearch([
      hit('chunk-1', 'source-1', 'unrelated material', 0.99),
      hit('chunk-2', 'source-2', 'enterprise GEO evidence', 0.7),
    ]);
    const service = new CitationSearchService(
      search,
      new ProviderRerankAdapter(configuration, new MockRerankProvider()),
    );

    const first = await service.search(input());
    const second = await service.search(input());

    expect(search.lastOptions).toMatchObject({ candidateLimit: 20, topK: 8 });
    expect(first.hits.map((item) => item.chunkId)).toEqual(['chunk-2', 'chunk-1']);
    expect(first).toMatchObject({
      contextVersion: 'citation-context/1.0.0',
      degraded: false,
      rerankModelKey: 'rerank-search-test-v1',
      warnings: [],
    });
    expect(first.hits[0]).toMatchObject({ rank: 1, rerankScore: expect.any(Number) });
    expect(first.contextHash).toBe(second.contextHash);
    expect(Object.isFrozen(first.hits)).toBe(true);
  });

  it('degrades to fused order with a structured warning and settled failure usage', async () => {
    const search = new FakeHybridSearch([
      hit('chunk-1', 'source-1', 'first evidence', 0.9),
      hit('chunk-2', 'source-2', 'second evidence', 0.8),
    ]);
    const service = new CitationSearchService(search, new FailingRerankAdapter());

    const context = await service.search(input());

    expect(context.hits.map((item) => item.chunkId)).toEqual(['chunk-1', 'chunk-2']);
    expect(context.hits.every((item) => item.rerankScore === null)).toBe(true);
    expect(context).toMatchObject({
      degraded: true,
      rerankUsage: { status: 'settled' },
      warnings: [
        {
          adapterCode: 'RERANK_PROVIDER_FAILED',
          code: 'RERANK_DEGRADED',
          retryable: true,
        },
      ],
    });
  });

  it('diversifies exact duplicates and source concentration before deterministic backfill', () => {
    const duplicateText = 'duplicate evidence';
    const ranked = [
      hit('a-1', 'source-a', 'one', 1),
      hit('a-2', 'source-a', 'two', 0.9),
      hit('a-3', 'source-a', 'three', 0.8),
      hit('b-1', 'source-b', duplicateText, 0.7),
      hit('c-1', 'source-c', duplicateText, 0.6),
      hit('d-1', 'source-d', 'six', 0.5),
    ].map((value) => ({ hit: value, rerankScore: value.score }));

    const selected = diversify(ranked, { citationTopK: 5, maxChunksPerSource: 2 });

    expect(selected.map((item) => item.hit.chunkId)).toEqual(['a-1', 'a-2', 'b-1', 'd-1', 'a-3']);
    expect(selected.find((item) => item.hit.chunkId === 'c-1')).toBeUndefined();
  });

  it('does not invoke rerank for an empty retrieval result', async () => {
    const adapter = new CountingRerankAdapter();
    const context = await new CitationSearchService(new FakeHybridSearch([]), adapter).search(
      input(),
    );
    expect(context.hits).toEqual([]);
    expect(context.degraded).toBe(false);
    expect(adapter.calls).toBe(0);
  });

  it('rejects poisoned chunk integrity before rerank or degradation', async () => {
    const poisoned = { ...hit('chunk-1', 'source-1', 'evidence', 0.9), textHash: 'f'.repeat(64) };
    const adapter = new CountingRerankAdapter();
    await expect(
      new CitationSearchService(new FakeHybridSearch([poisoned]), adapter).search(input()),
    ).rejects.toThrow(/invalid citation candidate/u);
    expect(adapter.calls).toBe(0);
  });
});

class FakeHybridSearch implements HybridSearchPort {
  public lastOptions: HybridSearchOptions | undefined;
  public constructor(private readonly hits: readonly HybridSearchHit[]) {}
  public search(
    _scope: HybridSearchScope,
    _rawQuery: string,
    _queryEmbedding: readonly number[],
    options: HybridSearchOptions,
  ): Promise<readonly HybridSearchHit[]> {
    this.lastOptions = options;
    return Promise.resolve(this.hits);
  }
}

class FailingRerankAdapter implements RerankAdapter {
  public readonly modelKey = 'rerank-failing-v1';
  public rerank(): Promise<RerankResult> {
    return Promise.reject(
      new RerankAdapterError('RERANK_PROVIDER_FAILED', 'secret provider detail', true, {
        durationMs: 1,
        inputCharacters: 10,
        inputDocuments: 2,
        inputTokens: 2,
        modelKey: this.modelKey,
        providerCode: 'test',
        providerModelId: 'test-model',
        providerRequestId: 'provider-request-1',
        status: 'settled',
      }),
    );
  }
}

class CountingRerankAdapter implements RerankAdapter {
  public calls = 0;
  public readonly modelKey = 'rerank-counting-v1';
  public rerank(_input: RerankInput): Promise<RerankResult> {
    void _input;
    this.calls += 1;
    return Promise.reject(new Error('must not be called'));
  }
}

function input() {
  return {
    effectiveOn: '2026-07-14',
    embeddingModelKey: 'embedding-v1',
    query: 'enterprise GEO',
    queryEmbedding: VECTOR,
    requestId: 'req-citation-search-0001',
    scope: SCOPE,
  } as const;
}

function hit(
  chunkId: string,
  sourceDocumentId: string,
  text: string,
  score: number,
): HybridSearchHit {
  return {
    chunkId,
    chunkNo: 0,
    ftsScore: score,
    matchSignals: ['fts', 'vector'],
    metadata: {
      char_end: text.length,
      char_start: 0,
      headings: [],
      schema_version: 'chunk-metadata@1',
    },
    projectId: SCOPE.projectId,
    score,
    sourceDocumentId,
    sourceTitle: `Title ${sourceDocumentId}`,
    sourceUri: `memory://${sourceDocumentId}`,
    text,
    textHash: createHash('sha256').update(text).digest('hex'),
    tokenCount: Math.max(1, text.split(/\s+/u).length),
    trustLevel: 'normal',
    vectorScore: score,
  };
}
