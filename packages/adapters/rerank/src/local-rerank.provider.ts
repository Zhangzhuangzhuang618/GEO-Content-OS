import { createHash } from 'node:crypto';

import type { RerankDocument, RerankProvider, RerankProviderResponse } from './rerank.types.js';

export class LocalRerankProvider implements RerankProvider {
  public readonly providerCode = 'local';
  public readonly providerModelId = 'local-ngram-rerank-v1';

  public rerank(
    query: string,
    documents: readonly RerankDocument[],
    requestId: string,
    signal: AbortSignal,
  ): Promise<RerankProviderResponse> {
    if (signal.aborted) {
      return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    const queryFeatures = features(query);
    return Promise.resolve({
      inputTokens:
        queryFeatures.size + documents.reduce((sum, item) => sum + features(item.text).size, 0),
      items: documents.map((document) => ({
        id: document.id,
        score: relevance(
          queryFeatures,
          `${document.title ?? ''}\n${document.text}`,
          document.textHash,
        ),
      })),
      providerRequestId: `local-${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}`,
    });
  }
}

function relevance(query: ReadonlySet<string>, text: string, textHash: string): number {
  const document = features(text);
  const overlap = [...query].filter((feature) => document.has(feature)).length;
  const coverage = query.size === 0 ? 0 : overlap / query.size;
  const precision = document.size === 0 ? 0 : overlap / document.size;
  const tieBreaker = createHash('sha256').update(textHash).digest().readUInt16BE(0) / 65_535;
  return Math.min(1, coverage * 0.84 + precision * 0.15 + tieBreaker * 0.01);
}

function features(value: string): ReadonlySet<string> {
  const normalized = value.normalize('NFKC').toLocaleLowerCase('und');
  const result = new Set<string>();
  for (const token of normalized.match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      const characters = Array.from(token);
      characters.forEach((character) => result.add(`h1:${character}`));
      for (let index = 0; index < characters.length - 1; index += 1) {
        result.add(`h2:${characters[index]}${characters[index + 1]}`);
      }
    } else {
      result.add(`w:${token}`);
    }
  }
  return result;
}
