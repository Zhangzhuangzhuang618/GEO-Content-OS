import type { EmbeddingUsage } from './embedding.types.js';

export type EmbeddingErrorCode =
  | 'EMBEDDING_CANCELLED'
  | 'EMBEDDING_INVALID_INPUT'
  | 'EMBEDDING_PROVIDER_FAILED'
  | 'EMBEDDING_RESPONSE_INVALID'
  | 'EMBEDDING_TIMEOUT'
  | 'EMBEDDING_UNAVAILABLE';

export class EmbeddingAdapterError extends Error {
  public constructor(
    public readonly code: EmbeddingErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly usage?: EmbeddingUsage,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'EmbeddingAdapterError';
  }
}

export class EmbeddingProviderError extends Error {
  public constructor(
    message: string,
    public readonly retryable = true,
    public readonly inputTokens?: number,
    public readonly providerRequestId?: string,
  ) {
    super(message);
    this.name = 'EmbeddingProviderError';
  }
}
