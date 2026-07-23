import type { EmbeddingAdapter } from '@geo-content-os/adapter-embedding';

import type { CitationSearchService } from '../../knowledge/search/index.js';
import { sha256 } from './claim-normalizer.js';
import type { FactEvidenceCandidate, FactEvidenceSearchPort } from './fact-check.types.js';

export class CitationEvidenceRetriever implements FactEvidenceSearchPort {
  public constructor(
    private readonly embeddingAdapter: EmbeddingAdapter,
    private readonly citationSearch: CitationSearchService,
  ) {}

  public async search(
    input: Parameters<FactEvidenceSearchPort['search']>[0],
  ): Promise<readonly FactEvidenceCandidate[]> {
    const requestId = `fact-check-${sha256(`${input.requestId}:${input.claim.claimHash}`).slice(0, 32)}`;
    const embedding = await this.embeddingAdapter.embedBatch({
      inputs: [
        {
          id: input.claim.claimHash,
          text: input.claim.normalizedClaimText,
          textHash: input.claim.claimHash,
        },
      ],
      requestId,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const vector = embedding.embeddings[0];
    if (!vector) return Object.freeze([]);

    const context = await this.citationSearch.search({
      embeddingModelKey: this.embeddingAdapter.modelKey,
      query: input.claim.normalizedClaimText,
      queryEmbedding: vector.vector,
      requestId,
      scope: {
        projectId: input.scope.projectId,
        tenantId: input.scope.tenantId,
        userId: input.scope.userId,
        workspaceId: input.scope.workspaceId,
      },
      ...(input.signal ? { signal: input.signal } : {}),
      trustLevels: ['verified', 'normal'],
    });

    return Object.freeze(
      context.hits.map((hit) =>
        Object.freeze({
          chunkId: hit.chunkId,
          factId: null,
          relevanceScore: hit.relevanceScore,
          sourceDocumentId: hit.sourceDocumentId,
          text: hit.text,
          textHash: hit.textHash,
          trustLevel: hit.trustLevel,
        }),
      ),
    );
  }
}
