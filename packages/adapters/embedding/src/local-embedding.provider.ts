import { createHash } from 'node:crypto';

import type {
  EmbeddingInput,
  EmbeddingProvider,
  EmbeddingProviderResponse,
} from './embedding.types.js';
import { EMBEDDING_DIMENSION } from './embedding.types.js';

/**
 * Dependency-free feature-hash embeddings for local/private deployments.
 * Character n-grams make Chinese queries and source text comparable without
 * sending source material to another provider.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  public readonly providerCode = 'local';
  public readonly providerModelId = 'local-ngram-embedding-1536-v1';

  public embedBatch(
    inputs: readonly EmbeddingInput[],
    requestId: string,
    signal: AbortSignal,
  ): Promise<EmbeddingProviderResponse> {
    if (signal.aborted) {
      return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    return Promise.resolve({
      embeddings: inputs.map((input) => ({ id: input.id, vector: featureVector(input.text) })),
      inputTokens: inputs.reduce((sum, input) => sum + features(input.text).length, 0),
      providerRequestId: `local-${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}`,
    });
  }
}

export function featureVector(text: string): readonly number[] {
  const vector = Array<number>(EMBEDDING_DIMENSION).fill(0);
  const extracted = features(text);
  const usable = extracted.length > 0 ? extracted : ['empty'];
  const frequencies = new Map<string, number>();
  usable.forEach((feature) => frequencies.set(feature, (frequencies.get(feature) ?? 0) + 1));
  for (const [feature, count] of frequencies) {
    const digest = createHash('sha256').update(feature).digest();
    const index = digest.readUInt32BE(0) % EMBEDDING_DIMENSION;
    const sign = digest[4]! % 2 === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign * (1 + Math.log(count));
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return Object.freeze(vector.map((value) => value / magnitude));
}

function features(value: string): string[] {
  const normalized = value.normalize('NFKC').toLocaleLowerCase('und');
  const result: string[] = [];
  for (const token of normalized.match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      const characters = Array.from(token);
      result.push(...characters.map((character) => `h1:${character}`));
      for (let index = 0; index < characters.length - 1; index += 1) {
        result.push(`h2:${characters[index]}${characters[index + 1]}`);
      }
      for (let index = 0; index < characters.length - 2; index += 1) {
        result.push(`h3:${characters[index]}${characters[index + 1]}${characters[index + 2]}`);
      }
    } else {
      result.push(`w:${token}`);
    }
  }
  return result;
}
