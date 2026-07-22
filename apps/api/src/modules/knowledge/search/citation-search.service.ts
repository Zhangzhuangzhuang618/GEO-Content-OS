import { createHash } from 'node:crypto';

import {
  RerankAdapterError,
  type RerankAdapter,
  type RerankUsage,
} from '@geo-content-os/adapter-rerank';

import {
  CITATION_CONTEXT_VERSION,
  type CitationContext,
  type CitationContextHit,
  type CitationContextWarning,
  type CitationSearchInput,
} from './citation-context.types.js';
import type { HybridSearchHit, HybridSearchPort } from './hybrid-search.types.js';
import { DEFAULT_SEARCH_POLICY, type SearchPolicy, validateSearchPolicy } from './search-policy.js';

export class CitationSearchService {
  private readonly policy: Readonly<SearchPolicy>;

  public constructor(
    private readonly hybridSearch: HybridSearchPort,
    private readonly rerankAdapter: RerankAdapter,
    policy: SearchPolicy = DEFAULT_SEARCH_POLICY,
  ) {
    this.policy = validateSearchPolicy(policy);
  }

  public async search(input: CitationSearchInput): Promise<CitationContext> {
    validateRequestId(input.requestId);
    const query = normalizeQuery(input.query);
    const retrieved = await this.hybridSearch.search(input.scope, query, input.queryEmbedding, {
      candidateLimit: this.policy.modalityCandidateLimit,
      ...(input.effectiveOn ? { effectiveOn: input.effectiveOn } : {}),
      modelKey: input.embeddingModelKey,
      ...(input.sourceDocumentIds ? { sourceDocumentIds: input.sourceDocumentIds } : {}),
      topK: this.policy.fusedCandidateLimit,
      ...(input.trustLevels ? { trustLevels: input.trustLevels } : {}),
    });
    assertHybridHits(retrieved);
    const hybridHits = retrieved.slice(0, this.policy.fusedCandidateLimit);

    let ordered = hybridHits.map((hit) => ({ hit, rerankScore: null as number | null }));
    let rerankUsage: RerankUsage | null = null;
    const warnings: CitationContextWarning[] = [];

    if (hybridHits.length > 0) {
      try {
        const result = await this.rerankAdapter.rerank({
          documents: hybridHits.map((hit) => ({
            id: hit.chunkId,
            text: hit.text,
            textHash: hit.textHash,
            title: hit.sourceTitle,
          })),
          query,
          requestId: rerankRequestId(input.requestId),
          ...(input.signal ? { signal: input.signal } : {}),
          topK: hybridHits.length,
        });
        rerankUsage = immutableUsage(result.usage);
        const hitsById = new Map(hybridHits.map((hit) => [hit.chunkId, hit]));
        ordered = result.items.map((item) => ({
          hit: hitsById.get(item.id)!,
          rerankScore: item.score,
        }));
      } catch (error) {
        if (input.signal?.aborted) throw error;
        const adapterError = error instanceof RerankAdapterError ? error : undefined;
        rerankUsage = adapterError?.usage ? immutableUsage(adapterError.usage) : null;
        warnings.push(
          Object.freeze({
            adapterCode: adapterError?.code ?? 'RERANK_UNKNOWN',
            code: 'RERANK_DEGRADED',
            message: 'Rerank unavailable; fused retrieval order was used',
            retryable: adapterError?.retryable ?? true,
          }),
        );
      }
    }

    const diversified = diversify(ordered, this.policy).map(({ hit, rerankScore }, index) =>
      citationHit(hit, rerankScore, index + 1),
    );
    const queryHash = sha256(query);
    const contextHash = sha256(
      JSON.stringify({
        contextVersion: CITATION_CONTEXT_VERSION,
        hits: diversified.map((hit) => ({
          chunkId: hit.chunkId,
          hybridScore: hit.hybridScore,
          rank: hit.rank,
          relevanceScore: hit.relevanceScore,
          rerankScore: hit.rerankScore,
          sourceDocumentId: hit.sourceDocumentId,
          textHash: hit.textHash,
        })),
        policy: this.policy,
        queryHash,
        rerankModelKey: this.rerankAdapter.modelKey,
        warnings: warnings.map((warning) => ({
          adapterCode: warning.adapterCode,
          code: warning.code,
          retryable: warning.retryable,
        })),
      }),
    );
    return Object.freeze({
      contextHash,
      contextVersion: CITATION_CONTEXT_VERSION,
      degraded: warnings.length > 0,
      hits: Object.freeze(diversified),
      queryHash,
      rerankModelKey: this.rerankAdapter.modelKey,
      rerankUsage,
      warnings: Object.freeze(warnings),
    });
  }
}

export interface RankedHybridHit {
  readonly hit: HybridSearchHit;
  readonly rerankScore: number | null;
}

export function diversify(
  ranked: readonly RankedHybridHit[],
  policy: Pick<SearchPolicy, 'citationTopK' | 'maxChunksPerSource'>,
): readonly RankedHybridHit[] {
  const deduplicated: RankedHybridHit[] = [];
  const candidateIds = new Set<string>();
  for (const item of ranked) {
    if (candidateIds.has(item.hit.chunkId)) continue;
    candidateIds.add(item.hit.chunkId);
    deduplicated.push(item);
  }
  const selected: RankedHybridHit[] = [];
  const selectedIds = new Set<string>();
  const textHashes = new Set<string>();
  const sourceCounts = new Map<string, number>();
  const take = (item: RankedHybridHit) => {
    selected.push(item);
    selectedIds.add(item.hit.chunkId);
    textHashes.add(item.hit.textHash);
    sourceCounts.set(
      item.hit.sourceDocumentId,
      (sourceCounts.get(item.hit.sourceDocumentId) ?? 0) + 1,
    );
  };
  for (const item of deduplicated) {
    if (selected.length >= policy.citationTopK) break;
    if (
      textHashes.has(item.hit.textHash) ||
      (sourceCounts.get(item.hit.sourceDocumentId) ?? 0) >= policy.maxChunksPerSource
    ) {
      continue;
    }
    take(item);
  }
  for (const item of deduplicated) {
    if (selected.length >= policy.citationTopK) break;
    if (selectedIds.has(item.hit.chunkId) || textHashes.has(item.hit.textHash)) continue;
    take(item);
  }
  for (const item of deduplicated) {
    if (selected.length >= policy.citationTopK) break;
    if (!selectedIds.has(item.hit.chunkId)) take(item);
  }
  return Object.freeze(selected);
}

function citationHit(
  hit: HybridSearchHit,
  rerankScore: number | null,
  rank: number,
): CitationContextHit {
  const normalizedRerank = rerankScore === null ? null : stableScore(rerankScore);
  const hybridScore = stableScore(hit.score);
  return Object.freeze({
    chunkId: hit.chunkId,
    chunkNo: hit.chunkNo,
    hybridScore,
    matchSignals: Object.freeze([...hit.matchSignals]),
    metadata: Object.freeze({
      ...hit.metadata,
      ...(hit.metadata.headings ? { headings: Object.freeze([...hit.metadata.headings]) } : {}),
    }),
    projectId: hit.projectId,
    rank,
    relevanceScore: normalizedRerank ?? hybridScore,
    rerankScore: normalizedRerank,
    sourceDocumentId: hit.sourceDocumentId,
    sourceTitle: hit.sourceTitle,
    sourceUri: hit.sourceUri,
    text: hit.text,
    textHash: hit.textHash,
    tokenCount: hit.tokenCount,
    trustLevel: hit.trustLevel,
  });
}

function normalizeQuery(value: string): string {
  const query = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (query.length < 2 || query.length > 500) {
    throw new TypeError('Citation search query must contain 2 to 500 characters');
  }
  return query;
}

function assertHybridHits(hits: readonly HybridSearchHit[]): void {
  const ids = new Set<string>();
  for (const hit of hits) {
    if (
      ids.has(hit.chunkId) ||
      !hit.text.trim() ||
      createHash('sha256').update(hit.text).digest('hex') !== hit.textHash ||
      !validScore(hit.score) ||
      !validScore(hit.ftsScore) ||
      !validScore(hit.vectorScore) ||
      hit.matchSignals.length === 0 ||
      hit.matchSignals.some((signal) => signal !== 'fts' && signal !== 'vector') ||
      new Set(hit.matchSignals).size !== hit.matchSignals.length
    ) {
      throw new TypeError('Hybrid search returned an invalid citation candidate');
    }
    ids.add(hit.chunkId);
  }
}

function immutableUsage(usage: RerankUsage): RerankUsage {
  return Object.freeze({ ...usage });
}

function validateRequestId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,79}$/u.test(value)) {
    throw new TypeError('Citation search request ID is invalid');
  }
}

function rerankRequestId(requestId: string): string {
  return `rerank-${sha256(requestId)}`;
}

function stableScore(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(12));
}

function validScore(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
