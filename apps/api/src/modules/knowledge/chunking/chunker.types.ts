import type { ParsedMaterialDocument } from '@geo-content-os/parsers';

import type { ChunkMetadata } from '../../../database/schema/index.js';

export const CHUNKER_VERSION = 'chunker/1.0.0' as const;

export interface ChunkingPolicy {
  readonly maxTokens: number;
  readonly minTokens: number;
  readonly overlapTokens: number;
  readonly targetTokens: number;
}

export interface SourceChunkDraft {
  readonly chunkNo: number;
  readonly chunkerVersion: typeof CHUNKER_VERSION;
  readonly metadata: ChunkMetadata;
  readonly text: string;
  readonly textHash: string;
  readonly tokenCount: number;
}

export type ChunkableMaterialDocument = ParsedMaterialDocument;
