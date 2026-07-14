import { describe, expect, it } from 'vitest';

import { readEmbeddingConfiguration } from './embedding.config.js';

describe('Embedding configuration', () => {
  it('uses bounded fail-closed defaults', () => {
    expect(readEmbeddingConfiguration({})).toEqual({
      driver: 'disabled',
      maxBatchSize: 64,
      maxInputCharacters: 1_000_000,
      modelKey: 'embedding-mock-v1',
      timeoutMs: 30_000,
    });
  });

  it('forbids production mock and invalid limits/model keys', () => {
    expect(() =>
      readEmbeddingConfiguration({ NODE_ENV: 'production', EMBEDDING_DRIVER: 'mock' }),
    ).toThrow();
    expect(() => readEmbeddingConfiguration({ EMBEDDING_DRIVER: 'unknown' })).toThrow();
    expect(() => readEmbeddingConfiguration({ EMBEDDING_MAX_BATCH_SIZE: '257' })).toThrow();
    expect(() => readEmbeddingConfiguration({ EMBEDDING_TIMEOUT_MS: '99' })).toThrow();
    expect(() => readEmbeddingConfiguration({ EMBEDDING_MODEL_KEY: 'bad model' })).toThrow();
  });
});
