export const EMBEDDING_ADAPTER_VERSION = 'embedding-adapter/1.0.0' as const;
export const EMBEDDING_DIMENSION = 1_536 as const;

export interface EmbeddingInput {
  readonly id: string;
  readonly text: string;
  readonly textHash: string;
}

export interface EmbedBatchInput {
  readonly inputs: readonly EmbeddingInput[];
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export interface EmbeddingVector {
  readonly id: string;
  readonly vector: readonly number[];
}

export interface EmbeddingUsage {
  readonly durationMs: number;
  readonly inputCharacters: number;
  readonly inputCount: number;
  readonly inputTokens: number | null;
  readonly modelKey: string;
  readonly providerCode: string;
  readonly providerModelId: string;
  readonly providerRequestId: string | null;
  readonly status: 'settled' | 'unknown';
}

export interface EmbedBatchResult {
  readonly adapterVersion: typeof EMBEDDING_ADAPTER_VERSION;
  readonly dimension: typeof EMBEDDING_DIMENSION;
  readonly embeddings: readonly EmbeddingVector[];
  readonly usage: EmbeddingUsage;
}

export interface EmbeddingProviderResponse {
  readonly embeddings: readonly EmbeddingVector[];
  readonly inputTokens: number;
  readonly providerRequestId: string;
}

export interface EmbeddingProvider {
  readonly providerCode: string;
  readonly providerModelId: string;
  embedBatch(
    inputs: readonly EmbeddingInput[],
    requestId: string,
    signal: AbortSignal,
  ): Promise<EmbeddingProviderResponse>;
}

export interface EmbeddingAdapter {
  readonly maxBatchSize: number;
  readonly modelKey: string;
  embedBatch(input: EmbedBatchInput): Promise<EmbedBatchResult>;
}
