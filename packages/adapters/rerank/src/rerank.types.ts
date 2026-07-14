export const RERANK_ADAPTER_VERSION = 'rerank-adapter/1.0.0' as const;

export interface RerankDocument {
  readonly id: string;
  readonly text: string;
  readonly textHash: string;
  readonly title?: string;
}

export interface RerankInput {
  readonly documents: readonly RerankDocument[];
  readonly query: string;
  readonly requestId: string;
  readonly signal?: AbortSignal;
  readonly topK: number;
}

export interface RerankItem {
  readonly id: string;
  readonly score: number;
}

export interface RerankUsage {
  readonly durationMs: number;
  readonly inputCharacters: number;
  readonly inputDocuments: number;
  readonly inputTokens: number | null;
  readonly modelKey: string;
  readonly providerCode: string;
  readonly providerModelId: string;
  readonly providerRequestId: string | null;
  readonly status: 'settled' | 'unknown';
}

export interface RerankResult {
  readonly adapterVersion: typeof RERANK_ADAPTER_VERSION;
  readonly items: readonly RerankItem[];
  readonly usage: RerankUsage;
}

export interface RerankProviderResponse {
  readonly inputTokens: number;
  readonly items: readonly RerankItem[];
  readonly providerRequestId: string;
}

export interface RerankProvider {
  readonly providerCode: string;
  readonly providerModelId: string;
  rerank(
    query: string,
    documents: readonly RerankDocument[],
    requestId: string,
    signal: AbortSignal,
  ): Promise<RerankProviderResponse>;
}

export interface RerankAdapter {
  readonly modelKey: string;
  rerank(input: RerankInput): Promise<RerankResult>;
}
