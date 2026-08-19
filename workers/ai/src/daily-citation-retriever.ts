import { createHash } from 'node:crypto';

import type { EmbeddingAdapter } from '@geo-content-os/adapter-embedding';
import type { CitationContext, CitationSearchInput } from '@geo-content-os/retrieval';

interface CitationSearchPort {
  search(input: CitationSearchInput): Promise<CitationContext>;
}

export interface DailyCitationRequest {
  readonly angle: string;
  readonly audience: string;
  readonly businessDate: string;
  readonly candidateNo: number;
  readonly keyword: string;
  readonly objective: string;
  readonly platformCode: string;
  readonly projectId: string;
  readonly tenantId: string;
  readonly title: string;
  readonly userId: string;
  readonly workspaceId: string;
}

export interface DailyCitation {
  readonly chunkId: string;
  readonly quoteText: string;
  readonly sourceId: string;
}

export interface DailyCitationSelection {
  readonly citations: readonly DailyCitation[];
  readonly contextHash: string;
  readonly degraded: boolean;
  readonly queryHash: string;
}

export interface DailyCitationPort {
  retrieve(input: DailyCitationRequest): Promise<DailyCitationSelection>;
}

export class DailyCitationRetriever implements DailyCitationPort {
  public constructor(
    private readonly embedding: EmbeddingAdapter,
    private readonly citationSearch: CitationSearchPort,
  ) {}

  public async retrieve(input: DailyCitationRequest): Promise<DailyCitationSelection> {
    const query = buildDailyCitationQuery(input);
    const requestHash = sha256(
      [
        input.tenantId,
        input.workspaceId,
        input.projectId,
        input.platformCode,
        input.businessDate,
        input.candidateNo,
        query,
      ].join(':'),
    );
    const embedded = await this.embedding.embedBatch({
      inputs: [
        {
          id: `daily-query-${requestHash.slice(0, 32)}`,
          text: query,
          textHash: sha256(query),
        },
      ],
      requestId: `daily-embed-${requestHash}`,
    });
    const vector = embedded.embeddings[0];
    if (!vector) throw new Error('Daily evidence query embedding was not generated');
    const context = await this.citationSearch.search({
      effectiveOn: input.businessDate,
      embeddingModelKey: this.embedding.modelKey,
      query,
      queryEmbedding: vector.vector,
      requestId: `daily-search-${requestHash}`,
      scope: {
        projectId: input.projectId,
        tenantId: input.tenantId,
        userId: input.userId,
        workspaceId: input.workspaceId,
      },
      trustLevels: ['verified', 'normal'],
    });
    const selectedHits: CitationContext['hits'][number][] = [];
    const sourceCounts = new Map<string, number>();
    for (const hit of context.hits) {
      if (selectedHits.length >= 5) break;
      const sourceCount = sourceCounts.get(hit.sourceDocumentId) ?? 0;
      if (sourceCount >= 2) continue;
      selectedHits.push(hit);
      sourceCounts.set(hit.sourceDocumentId, sourceCount + 1);
    }
    return Object.freeze({
      citations: Object.freeze(
        selectedHits.map((hit) =>
          Object.freeze({
            chunkId: hit.chunkId,
            quoteText: hit.text,
            sourceId: hit.sourceDocumentId,
          }),
        ),
      ),
      contextHash: context.contextHash,
      degraded: context.degraded,
      queryHash: context.queryHash,
    });
  }
}

export function buildDailyCitationQuery(
  input: Pick<DailyCitationRequest, 'angle' | 'audience' | 'keyword' | 'objective' | 'title'>,
): string {
  return [input.keyword, input.title, input.angle, input.objective, input.audience]
    .join(' ')
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 500);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
