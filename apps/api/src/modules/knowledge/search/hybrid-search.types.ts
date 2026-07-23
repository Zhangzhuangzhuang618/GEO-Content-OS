import type { ChunkMetadata, SourceTrustLevel } from '../../../database/schema/index.js';

export type SearchableTrustLevel = Exclude<SourceTrustLevel, 'untrusted'>;
export type HybridSearchSignal = 'fts' | 'vector';

export interface HybridSearchScope {
  readonly projectId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

export interface HybridSearchOptions {
  readonly candidateLimit?: number;
  readonly effectiveOn?: string;
  readonly modelKey: string;
  readonly sourceDocumentIds?: readonly string[];
  readonly topK?: number;
  readonly trustLevels?: readonly SearchableTrustLevel[];
}

export interface HybridSearchPort {
  search(
    scope: HybridSearchScope,
    rawQuery: string,
    queryEmbedding: readonly number[],
    options: HybridSearchOptions,
  ): Promise<readonly HybridSearchHit[]>;
}

export interface HybridSearchHit {
  readonly chunkId: string;
  readonly chunkNo: number;
  readonly ftsScore: number;
  readonly matchSignals: readonly HybridSearchSignal[];
  readonly metadata: ChunkMetadata;
  readonly projectId: string | null;
  readonly score: number;
  readonly sourceDocumentId: string;
  readonly sourceTitle: string;
  readonly sourceUri: string;
  readonly text: string;
  readonly textHash: string;
  readonly tokenCount: number;
  readonly trustLevel: SearchableTrustLevel;
  readonly vectorScore: number;
}

export interface ValidatedHybridSearchRequest {
  readonly candidateLimit: number;
  readonly effectiveOn: string;
  readonly modelKey: string;
  readonly query: string;
  readonly sourceDocumentIds: readonly string[];
  readonly topK: number;
  readonly trustLevels: readonly SearchableTrustLevel[];
  readonly vectorLiteral: string;
}
