import type { RerankUsage } from './rerank.types.js';

export type RerankErrorCode =
  | 'RERANK_CANCELLED'
  | 'RERANK_INVALID_INPUT'
  | 'RERANK_PROVIDER_FAILED'
  | 'RERANK_RESPONSE_INVALID'
  | 'RERANK_TIMEOUT'
  | 'RERANK_UNAVAILABLE';

export class RerankAdapterError extends Error {
  public constructor(
    public readonly code: RerankErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly usage?: RerankUsage,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RerankAdapterError';
  }
}

export class RerankProviderError extends Error {
  public constructor(
    message: string,
    public readonly retryable = true,
    public readonly inputTokens?: number,
    public readonly providerRequestId?: string,
  ) {
    super(message);
    this.name = 'RerankProviderError';
  }
}
