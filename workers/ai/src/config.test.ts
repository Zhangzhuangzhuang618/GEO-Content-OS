import { describe, expect, it } from 'vitest';

import { readAiWorkerConfig } from './config.js';

const PROMPT_ID = '25000000-0000-4000-8000-000000000008';
const QUALITY_PROMPT_ID = '25000000-0000-4000-8000-000000000007';

describe('AI Worker model routing configuration', () => {
  it('accepts distinct DeepSeek quality generation and checker models', () => {
    const config = readAiWorkerConfig(environment());

    expect(config.automation).toMatchObject({
      draftModelKey: 'deepseek-v4-flash',
      qualityModelKey: 'deepseek-v4-pro',
      rewriteModelKey: 'deepseek-v4-pro',
    });
  });

  it('rejects a quality generation model that collapses onto the Flash route', () => {
    expect(() =>
      readAiWorkerConfig(environment({ CONTENT_MODEL_QUALITY_KEY: 'deepseek-v4-flash' })),
    ).toThrow('CONTENT_MODEL_QUALITY_KEY must differ');
  });

  it('rejects a quality checker model that collapses onto the Flash route', () => {
    expect(() =>
      readAiWorkerConfig(environment({ QUALITY_CHECKER_MODEL_KEY: 'deepseek-v4-flash' })),
    ).toThrow('QUALITY_CHECKER_MODEL_KEY must differ');
  });
});

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AI_MODEL_DRIVER: 'deepseek',
    CONTENT_MODEL_BALANCED_KEY: 'deepseek-v4-flash',
    CONTENT_MODEL_FAST_KEY: 'deepseek-v4-flash',
    CONTENT_MODEL_QUALITY_KEY: 'deepseek-v4-pro',
    CONTENT_WRITER_PROMPT_VERSION_ID: PROMPT_ID,
    DATABASE_URL: 'postgresql://geo:test@localhost:5432/geo',
    QUALITY_CHECKER_MODEL_KEY: 'deepseek-v4-pro',
    QUALITY_CHECKER_PROMPT_VERSION_ID: QUALITY_PROMPT_ID,
    REDIS_URL: 'redis://localhost:6379/0',
    ...overrides,
  };
}
