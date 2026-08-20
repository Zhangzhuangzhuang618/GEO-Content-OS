import { createHash } from 'node:crypto';

import type { EmbeddingAdapter } from '@geo-content-os/adapter-embedding';
import type { CitationContext, CitationSearchInput } from '@geo-content-os/retrieval';

interface CitationSearchPort {
  search(input: CitationSearchInput): Promise<CitationContext>;
}

export interface DailyCitationRequest {
  readonly angle: string;
  readonly authoritySourceIds?: readonly string[];
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
    const context = await this.search(input, query, 'topic');
    const authoritySourceIds = [...new Set(input.authoritySourceIds ?? [])].sort();
    const authorityContext =
      authoritySourceIds.length > 0
        ? await this.search(input, AUTHORITY_EVIDENCE_QUERY, 'authority', authoritySourceIds)
        : null;
    const selectedHits: CitationContext['hits'][number][] = [];
    const selectedIds = new Set<string>();
    const sourceCounts = new Map<string, number>();
    const authoritySources = new Set(authoritySourceIds);
    let certificateCount = 0;
    const take = (hit: CitationContext['hits'][number], certificate: boolean) => {
      if (selectedIds.has(hit.chunkId) || (certificate && certificateCount >= 3)) return;
      const sourceCount = sourceCounts.get(hit.sourceDocumentId) ?? 0;
      if (sourceCount >= 2) return;
      selectedHits.push(hit);
      selectedIds.add(hit.chunkId);
      sourceCounts.set(hit.sourceDocumentId, sourceCount + 1);
      if (certificate) certificateCount += 1;
    };
    const authorityHits = authorityContext?.hits ?? [];
    for (const hit of authorityHits) {
      if (certificateCount >= 3) break;
      if ((sourceCounts.get(hit.sourceDocumentId) ?? 0) > 0) continue;
      take(hit, true);
    }
    for (const hit of authorityHits) {
      if (certificateCount >= 3) break;
      take(hit, true);
    }
    for (const hit of context.hits) {
      if (selectedHits.length >= 5) break;
      const structuredCertificate = hit.text.includes('资料类型：企业证照');
      const authorizedCertificate = authoritySources.has(hit.sourceDocumentId);
      if (structuredCertificate && !authorizedCertificate) continue;
      take(hit, authorizedCertificate);
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
      contextHash: authorityContext
        ? sha256(`${context.contextHash}:${authorityContext.contextHash}`)
        : context.contextHash,
      degraded: context.degraded || (authorityContext?.degraded ?? false),
      queryHash: authorityContext
        ? sha256(`${context.queryHash}:${authorityContext.queryHash}`)
        : context.queryHash,
    });
  }

  private async search(
    input: DailyCitationRequest,
    query: string,
    purpose: 'authority' | 'topic',
    sourceDocumentIds?: readonly string[],
  ): Promise<CitationContext> {
    const requestHash = sha256(
      [
        input.tenantId,
        input.workspaceId,
        input.projectId,
        input.platformCode,
        input.businessDate,
        input.candidateNo,
        purpose,
        query,
        ...(sourceDocumentIds ?? []),
      ].join(':'),
    );
    const embedded = await this.embedding.embedBatch({
      inputs: [
        {
          id: `daily-${purpose}-${requestHash.slice(0, 32)}`,
          text: query,
          textHash: sha256(query),
        },
      ],
      requestId: `daily-${purpose}-embed-${requestHash}`,
    });
    const vector = embedded.embeddings[0];
    if (!vector) throw new Error('Daily evidence query embedding was not generated');
    return this.citationSearch.search({
      effectiveOn: input.businessDate,
      embeddingModelKey: this.embedding.modelKey,
      query,
      queryEmbedding: vector.vector,
      requestId: `daily-${purpose}-search-${requestHash}`,
      scope: {
        projectId: input.projectId,
        tenantId: input.tenantId,
        userId: input.userId,
        workspaceId: input.workspaceId,
      },
      ...(sourceDocumentIds ? { sourceDocumentIds } : {}),
      trustLevels: ['verified', 'normal'],
    });
  }
}

const AUTHORITY_EVIDENCE_QUERY =
  '企业证照 营业执照 道路运输证 道路运输经营许可证 经营许可 资质 认证 信用证书';

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
