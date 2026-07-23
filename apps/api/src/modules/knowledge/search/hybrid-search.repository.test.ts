import { describe, expect, it } from 'vitest';

import { validateHybridSearchRequest } from './hybrid-search.repository.js';

const VECTOR = Object.freeze([1, ...Array<number>(1_535).fill(0)]);

describe('hybrid search request validation', () => {
  it('normalizes bounded controls and keeps a stable vector literal', () => {
    expect(
      validateHybridSearchRequest('  企业   GEO  ', VECTOR, {
        effectiveOn: '2026-07-14',
        modelKey: 'embedding-v1',
        sourceDocumentIds: ['53000000-0000-4000-8000-000000000001'],
        topK: 3,
        trustLevels: ['verified'],
      }),
    ).toMatchObject({
      candidateLimit: 20,
      effectiveOn: '2026-07-14',
      modelKey: 'embedding-v1',
      query: '企业 GEO',
      sourceDocumentIds: ['53000000-0000-4000-8000-000000000001'],
      topK: 3,
      trustLevels: ['verified'],
    });
  });

  it('rejects unsafe query, vector, model, date, topK, and trust controls', () => {
    const valid = { effectiveOn: '2026-07-14', modelKey: 'embedding-v1' } as const;
    const invalidCalls = [
      () => validateHybridSearchRequest(' ', VECTOR, valid),
      () => validateHybridSearchRequest('ok', [1], valid),
      () => validateHybridSearchRequest('ok', Array<number>(1_536).fill(0), valid),
      () => validateHybridSearchRequest('ok', [Number.NaN, ...VECTOR.slice(1)], valid),
      () => validateHybridSearchRequest('ok', [Number.MAX_VALUE, ...VECTOR.slice(1)], valid),
      () => validateHybridSearchRequest('ok', VECTOR, { ...valid, modelKey: 'bad model' }),
      () => validateHybridSearchRequest('ok', VECTOR, { ...valid, effectiveOn: '2026-02-30' }),
      () => validateHybridSearchRequest('ok', VECTOR, { ...valid, topK: 21 }),
      () => validateHybridSearchRequest('ok', VECTOR, { ...valid, topK: 10, candidateLimit: 9 }),
      () => validateHybridSearchRequest('ok', VECTOR, { ...valid, candidateLimit: 101 }),
      () => validateHybridSearchRequest('ok', VECTOR, { ...valid, trustLevels: [] }),
      () =>
        validateHybridSearchRequest('ok', VECTOR, {
          ...valid,
          trustLevels: ['normal', 'normal'],
        }),
      () =>
        validateHybridSearchRequest('ok', VECTOR, {
          ...valid,
          sourceDocumentIds: ['not-a-uuid'],
        }),
    ];
    invalidCalls.forEach((call) => expect(call).toThrow(TypeError));
  });
});
