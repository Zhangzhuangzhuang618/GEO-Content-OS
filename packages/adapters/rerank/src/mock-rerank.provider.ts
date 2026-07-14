import { createHash } from 'node:crypto';

import type { RerankDocument, RerankProvider, RerankProviderResponse } from './rerank.types.js';

export interface MockRerankProviderOptions {
  readonly fail?: boolean;
  readonly latencyMs?: number;
}

export class MockRerankProvider implements RerankProvider {
  public readonly providerCode = 'mock';
  public readonly providerModelId = 'mock-rerank-v1';
  public constructor(private readonly options: MockRerankProviderOptions = {}) {}

  public async rerank(
    query: string,
    documents: readonly RerankDocument[],
    requestId: string,
    signal: AbortSignal,
  ): Promise<RerankProviderResponse> {
    await delay(this.options.latencyMs ?? 0, signal);
    if (this.options.fail) throw new Error('Mock rerank failure');
    const queryTerms = terms(query);
    return Object.freeze({
      inputTokens: Math.max(
        1,
        query.length + documents.reduce((total, document) => total + document.text.length, 0),
      ),
      items: Object.freeze(
        documents.map((document) =>
          Object.freeze({ id: document.id, score: relevance(queryTerms, document) }),
        ),
      ),
      providerRequestId: `mock-${requestId}`,
    });
  }
}

function relevance(queryTerms: ReadonlySet<string>, document: RerankDocument): number {
  const documentTerms = terms(`${document.title ?? ''} ${document.text}`);
  const overlap = [...queryTerms].filter((term) => documentTerms.has(term)).length;
  const lexical = queryTerms.size === 0 ? 0 : overlap / queryTerms.size;
  const tieBreaker =
    createHash('sha256').update(document.textHash).digest().readUInt16BE(0) / 65_535;
  return Math.min(1, lexical * 0.99 + tieBreaker * 0.01);
}

function terms(value: string): ReadonlySet<string> {
  return new Set(
    value
      .normalize('NFKC')
      .toLocaleLowerCase('und')
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  );
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Rerank aborted'));
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Rerank aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}
