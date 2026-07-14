import { describe, expect, it } from 'vitest';

import { DEFAULT_SEARCH_POLICY, validateSearchPolicy } from './search-policy.js';

describe('SearchPolicy', () => {
  it('freezes the documented 20 -> 8 -> 5 defaults', () => {
    expect(DEFAULT_SEARCH_POLICY).toEqual({
      citationTopK: 5,
      fusedCandidateLimit: 8,
      maxChunksPerSource: 2,
      modalityCandidateLimit: 20,
    });
    expect(Object.isFrozen(DEFAULT_SEARCH_POLICY)).toBe(true);
  });

  it('rejects inconsistent or unbounded policies', () => {
    expect(() =>
      validateSearchPolicy({ ...DEFAULT_SEARCH_POLICY, modalityCandidateLimit: 101 }),
    ).toThrow();
    expect(() =>
      validateSearchPolicy({ ...DEFAULT_SEARCH_POLICY, fusedCandidateLimit: 21 }),
    ).toThrow();
    expect(() => validateSearchPolicy({ ...DEFAULT_SEARCH_POLICY, citationTopK: 9 })).toThrow();
    expect(() =>
      validateSearchPolicy({ ...DEFAULT_SEARCH_POLICY, maxChunksPerSource: 6 }),
    ).toThrow();
  });
});
