import { createHash } from 'node:crypto';

import type {
  EmbedBatchInput,
  EmbedBatchResult,
  EmbeddingAdapter,
} from '@geo-content-os/adapter-embedding';
import type { CitationContext, CitationSearchInput } from '@geo-content-os/retrieval';
import { describe, expect, it } from 'vitest';

import { buildDailyCitationQuery, DailyCitationRetriever } from './daily-citation-retriever.js';

const VECTOR = Object.freeze([1, ...Array<number>(1_535).fill(0)]);
const REQUEST = Object.freeze({
  angle: '准备清单',
  audience: '正在搜索广州搬家并需要服务决策信息的用户',
  businessDate: '2026-08-19',
  candidateNo: 2,
  keyword: '广州搬家',
  objective: 'education',
  platformCode: 'lieju',
  projectId: '43000000-0000-4000-8000-000000000037',
  tenantId: '23000000-0000-4000-8000-000000000037',
  title: '广州搬家前要准备哪些事项',
  userId: '13000000-0000-4000-8000-000000000037',
  workspaceId: '33000000-0000-4000-8000-000000000037',
});

describe('DailyCitationRetriever', () => {
  it('builds a candidate-specific query and freezes the selected evidence', async () => {
    const embedding = new FakeEmbedding();
    const search = new FakeCitationSearch();
    const selection = await new DailyCitationRetriever(embedding, search).retrieve(REQUEST);

    expect(embedding.lastInput?.inputs[0]?.text).toBe(
      '广州搬家 广州搬家前要准备哪些事项 准备清单 education 正在搜索广州搬家并需要服务决策信息的用户',
    );
    expect(search.lastInput).toMatchObject({
      effectiveOn: '2026-08-19',
      embeddingModelKey: 'embedding-test-v1',
      queryEmbedding: VECTOR,
      scope: {
        projectId: REQUEST.projectId,
        tenantId: REQUEST.tenantId,
        userId: REQUEST.userId,
        workspaceId: REQUEST.workspaceId,
      },
      trustLevels: ['verified', 'normal'],
    });
    expect(selection.citations).toEqual([
      { chunkId: 'chunk-1', quoteText: '候选相关证据', sourceId: 'source-1' },
    ]);
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.citations)).toBe(true);
  });

  it('normalizes and bounds all query dimensions', () => {
    expect(
      buildDailyCitationQuery({
        angle: '  风险\n避坑 ',
        audience: '目标  用户',
        keyword: ' 广州搬家 ',
        objective: 'trust',
        title: '怎么选择',
      }),
    ).toBe('广州搬家 怎么选择 风险 避坑 trust 目标 用户');
  });

  it('keeps topic and authority adapter request IDs valid and distinct', async () => {
    const embedding = new FakeEmbedding();
    const search = new FakeCitationSearch();

    await new DailyCitationRetriever(embedding, search).retrieve({
      ...REQUEST,
      authoritySourceIds: ['source-license'],
    });

    const requestIds = [
      ...embedding.inputs.map((input) => input.requestId),
      ...search.inputs.map((input) => input.requestId),
    ];
    expect(requestIds).toEqual([
      expect.stringMatching(/^daily-topic-embed-[a-f0-9]{32}$/u),
      expect.stringMatching(/^daily-authority-embed-[a-f0-9]{32}$/u),
      expect.stringMatching(/^daily-topic-search-[a-f0-9]{32}$/u),
      expect.stringMatching(/^daily-authority-search-[a-f0-9]{32}$/u),
    ]);
    expect(new Set(requestIds).size).toBe(requestIds.length);
    for (const requestId of requestIds) {
      expect(requestId.length).toBeGreaterThanOrEqual(16);
      expect(requestId.length).toBeLessThanOrEqual(80);
    }

    await new DailyCitationRetriever(embedding, search).retrieve({
      ...REQUEST,
      authoritySourceIds: ['source-license'],
    });
    expect([
      ...embedding.inputs.slice(2).map((input) => input.requestId),
      ...search.inputs.slice(2).map((input) => input.requestId),
    ]).toEqual(requestIds);
  });

  it('keeps at most five chunks and at most two from one source', async () => {
    const search = new FakeCitationSearch([
      citationHit('chunk-a1', 'source-a'),
      citationHit('chunk-a2', 'source-a'),
      citationHit('chunk-a3', 'source-a'),
      citationHit('chunk-b1', 'source-b'),
      citationHit('chunk-c1', 'source-c'),
      citationHit('chunk-d1', 'source-d'),
    ]);

    const selection = await new DailyCitationRetriever(new FakeEmbedding(), search).retrieve(
      REQUEST,
    );

    expect(selection.citations.map((citation) => citation.chunkId)).toEqual([
      'chunk-a1',
      'chunk-a2',
      'chunk-b1',
      'chunk-c1',
      'chunk-d1',
    ]);
  });

  it('reserves up to three slots for authorized certificate evidence before topical evidence', async () => {
    const search = new FakeCitationSearch(
      [
        citationHit('chunk-topic-1', 'source-topic-1'),
        citationHit('chunk-topic-2', 'source-topic-2'),
        citationHit('chunk-topic-3', 'source-topic-3'),
        citationHit('chunk-topic-4', 'source-topic-4'),
      ],
      [
        citationHit('chunk-license', 'source-license'),
        citationHit('chunk-license-back', 'source-license'),
        citationHit('chunk-license-extra', 'source-license'),
        citationHit('chunk-road-certificate', 'source-road-certificate'),
        citationHit('chunk-permit', 'source-permit'),
      ],
    );

    const selection = await new DailyCitationRetriever(new FakeEmbedding(), search).retrieve({
      ...REQUEST,
      authoritySourceIds: ['source-license', 'source-permit', 'source-road-certificate'],
    });

    expect(selection.citations.map((citation) => citation.chunkId)).toEqual([
      'chunk-license',
      'chunk-road-certificate',
      'chunk-permit',
      'chunk-topic-1',
      'chunk-topic-2',
    ]);
    expect(search.inputs[1]).toMatchObject({
      sourceDocumentIds: ['source-license', 'source-permit', 'source-road-certificate'],
      trustLevels: ['verified', 'normal'],
    });
  });

  it('drops unauthorized certificate hits from topic retrieval and never selects more than three certificates', async () => {
    const certificate = (name: string) => `资料类型：企业证照\n证照名称：${name}`;
    const search = new FakeCitationSearch(
      [
        citationHit('chunk-unauthorized', 'source-unauthorized', certificate('未授权证照')),
        citationHit('chunk-authority-3-topic', 'source-authority-3', certificate('证照三')),
        citationHit('chunk-authority-4-topic', 'source-authority-4', certificate('证照四')),
        citationHit('chunk-topic', 'source-topic', '普通主题资料'),
      ],
      [
        citationHit('chunk-authority-1', 'source-authority-1', certificate('证照一')),
        citationHit('chunk-authority-2', 'source-authority-2', certificate('证照二')),
      ],
    );

    const selection = await new DailyCitationRetriever(new FakeEmbedding(), search).retrieve({
      ...REQUEST,
      authoritySourceIds: [
        'source-authority-1',
        'source-authority-2',
        'source-authority-3',
        'source-authority-4',
      ],
    });

    expect(selection.citations.map((citation) => citation.chunkId)).toEqual([
      'chunk-authority-1',
      'chunk-authority-2',
      'chunk-authority-3-topic',
      'chunk-topic',
    ]);
  });
});

class FakeEmbedding implements EmbeddingAdapter {
  public readonly inputs: EmbedBatchInput[] = [];
  public lastInput: EmbedBatchInput | undefined;
  public readonly maxBatchSize = 1;
  public readonly modelKey = 'embedding-test-v1';

  public embedBatch(input: EmbedBatchInput): Promise<EmbedBatchResult> {
    this.lastInput = input;
    this.inputs.push(input);
    return Promise.resolve({
      adapterVersion: 'embedding-adapter/1.0.0',
      dimension: 1_536,
      embeddings: [{ id: input.inputs[0]!.id, vector: VECTOR }],
      usage: {
        durationMs: 1,
        inputCharacters: input.inputs[0]!.text.length,
        inputCount: 1,
        inputTokens: 10,
        modelKey: this.modelKey,
        providerCode: 'test',
        providerModelId: 'test',
        providerRequestId: 'request-1',
        status: 'settled',
      },
    });
  }
}

class FakeCitationSearch {
  public readonly inputs: CitationSearchInput[] = [];
  public lastInput: CitationSearchInput | undefined;

  public constructor(
    private readonly hits: CitationContext['hits'] = [citationHit('chunk-1', 'source-1')],
    private readonly authorityHits: CitationContext['hits'] = [],
  ) {}

  public search(input: CitationSearchInput): Promise<CitationContext> {
    this.lastInput = input;
    this.inputs.push(input);
    return Promise.resolve({
      contextHash: 'a'.repeat(64),
      contextVersion: 'citation-context/1.0.0',
      degraded: false,
      hits: input.sourceDocumentIds ? this.authorityHits : this.hits,
      queryHash: 'b'.repeat(64),
      rerankModelKey: 'rerank-test-v1',
      rerankUsage: null,
      warnings: [],
    });
  }
}

function citationHit(
  chunkId: string,
  sourceDocumentId: string,
  text = '候选相关证据',
): CitationContext['hits'][number] {
  return {
    chunkId,
    chunkNo: 0,
    hybridScore: 0.9,
    matchSignals: ['fts', 'vector'],
    metadata: { schema_version: 'chunk-metadata@1' },
    projectId: REQUEST.projectId,
    rank: 1,
    relevanceScore: 0.9,
    rerankScore: 0.9,
    sourceDocumentId,
    sourceTitle: '企业资料',
    sourceUri: `memory://${sourceDocumentId}`,
    text,
    textHash: createHash('sha256').update(text).digest('hex'),
    tokenCount: 5,
    trustLevel: 'verified',
  };
}
