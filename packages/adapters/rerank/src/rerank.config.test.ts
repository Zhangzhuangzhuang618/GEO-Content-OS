import { describe, expect, it } from 'vitest';

import { readRerankConfiguration } from './rerank.config.js';

describe('Rerank configuration', () => {
  it('uses bounded fail-closed defaults', () => {
    expect(readRerankConfiguration({})).toEqual({
      driver: 'disabled',
      maxDocuments: 20,
      maxInputCharacters: 200_000,
      modelKey: 'rerank-mock-v1',
      timeoutMs: 10_000,
    });
  });

  it('forbids production mock and invalid controls', () => {
    expect(() =>
      readRerankConfiguration({ NODE_ENV: 'production', RERANK_DRIVER: 'mock' }),
    ).toThrow();
    expect(() => readRerankConfiguration({ RERANK_DRIVER: 'unknown' })).toThrow();
    expect(() => readRerankConfiguration({ RERANK_MAX_DOCUMENTS: '101' })).toThrow();
    expect(() => readRerankConfiguration({ RERANK_TIMEOUT_MS: '99' })).toThrow();
    expect(() => readRerankConfiguration({ RERANK_MODEL_KEY: 'bad model' })).toThrow();
  });
});
