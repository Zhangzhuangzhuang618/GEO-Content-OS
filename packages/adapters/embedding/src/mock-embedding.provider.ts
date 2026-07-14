import { createHash } from 'node:crypto';

import type {
  EmbeddingInput,
  EmbeddingProvider,
  EmbeddingProviderResponse,
} from './embedding.types.js';
import { EMBEDDING_DIMENSION } from './embedding.types.js';

export interface MockEmbeddingProviderOptions {
  readonly failOnCall?: number;
  readonly latencyMs?: number;
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  public readonly providerCode = 'mock';
  public readonly providerModelId = 'mock-embedding-1536-v1';
  private callCount = 0;

  public constructor(private readonly options: MockEmbeddingProviderOptions = {}) {}

  public async embedBatch(
    inputs: readonly EmbeddingInput[],
    requestId: string,
    signal: AbortSignal,
  ): Promise<EmbeddingProviderResponse> {
    this.callCount += 1;
    await delay(this.options.latencyMs ?? 0, signal);
    if (this.options.failOnCall === this.callCount) throw new Error('Mock embedding failure');
    return {
      embeddings: inputs.map((input) =>
        Object.freeze({ id: input.id, vector: vector(input.textHash) }),
      ),
      inputTokens: inputs.reduce((sum, input) => sum + Math.max(1, input.text.length), 0),
      providerRequestId: `mock-${requestId}-${this.callCount}`,
    };
  }
}

function vector(textHash: string): readonly number[] {
  let state = createHash('sha256').update(textHash).digest().readUInt32LE(0) || 1;
  const values = Array.from({ length: EMBEDDING_DIMENSION }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 0xffff_ffff) * 2 - 1;
  });
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return Object.freeze(values.map((value) => value / magnitude));
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Embedding aborted'));
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Embedding aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}
