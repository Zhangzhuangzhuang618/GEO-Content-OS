import type { RerankErrorCode, RerankUsage } from '@geo-content-os/adapter-rerank';

import type { ChunkMetadata } from '../../../database/schema/index.js';
import type {
  HybridSearchScope,
  HybridSearchSignal,
  SearchableTrustLevel,
} from './hybrid-search.types.js';

export const CITATION_CONTEXT_VERSION = 'citation-context/1.0.0' as const;

export interface CitationSearchInput {
  readonly effectiveOn?: string;
  readonly embeddingModelKey: string;
  readonly query: string;
  readonly queryEmbedding: readonly number[];
  readonly requestId: string;
  readonly scope: HybridSearchScope;
  readonly signal?: AbortSignal;
  readonly trustLevels?: readonly SearchableTrustLevel[];
}

export interface CitationContextHit {
  readonly chunkId: string;
  readonly chunkNo: number;
  readonly hybridScore: number;
  readonly matchSignals: readonly HybridSearchSignal[];
  readonly metadata: ChunkMetadata;
  readonly projectId: string | null;
  readonly rank: number;
  readonly relevanceScore: number;
  readonly rerankScore: number | null;
  readonly sourceDocumentId: string;
  readonly sourceTitle: string;
  readonly sourceUri: string;
  readonly text: string;
  readonly textHash: string;
  readonly tokenCount: number;
  readonly trustLevel: SearchableTrustLevel;
}

export interface CitationContextWarning {
  readonly adapterCode: RerankErrorCode | 'RERANK_UNKNOWN';
  readonly code: 'RERANK_DEGRADED';
  readonly message: 'Rerank unavailable; fused retrieval order was used';
  readonly retryable: boolean;
}

export interface CitationContext {
  readonly contextHash: string;
  readonly contextVersion: typeof CITATION_CONTEXT_VERSION;
  readonly degraded: boolean;
  readonly hits: readonly CitationContextHit[];
  readonly queryHash: string;
  readonly rerankModelKey: string;
  readonly rerankUsage: RerankUsage | null;
  readonly warnings: readonly CitationContextWarning[];
}
