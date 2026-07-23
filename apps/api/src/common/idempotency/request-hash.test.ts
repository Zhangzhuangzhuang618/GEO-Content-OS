import { describe, expect, it } from 'vitest';

import {
  buildIdempotencyScope,
  IdempotencyKeyValidationError,
  parseIdempotencyKey,
} from './idempotency-key.js';
import { canonicalJson, hashRequest } from './request-hash.js';

describe('request hash', () => {
  it('is stable across object key order but preserves array order', () => {
    const first = hashRequest({
      body: { nested: { b: 2, a: 1 }, platforms: ['zhihu', 'official_site'] },
      method: 'post',
      path: '/api/v1/content-packages',
    });
    const reordered = hashRequest({
      body: { platforms: ['zhihu', 'official_site'], nested: { a: 1, b: 2 } },
      method: 'POST',
      path: '/api/v1/content-packages',
    });
    const different = hashRequest({
      body: { nested: { a: 1, b: 2 }, platforms: ['official_site', 'zhihu'] },
      method: 'POST',
      path: '/api/v1/content-packages',
    });

    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(reordered).toBe(first);
    expect(different).not.toBe(first);
  });

  it('rejects values that JSON cannot represent deterministically', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow('non-finite');
  });
});

describe('Idempotency-Key and scope', () => {
  it('accepts one printable key and constructs an actor-route scope', () => {
    expect(parseIdempotencyKey(' request-123 ')).toBe('request-123');
    expect(
      buildIdempotencyScope({ actorId: 'user-1', method: 'post', route: '/content-packages' }),
    ).toBe('user-1:POST:/content-packages');
  });

  it('rejects missing, repeated, whitespace, and oversized keys', () => {
    expect(() => parseIdempotencyKey(undefined)).toThrow(IdempotencyKeyValidationError);
    expect(() => parseIdempotencyKey(['one', 'two'])).toThrow(IdempotencyKeyValidationError);
    expect(() => parseIdempotencyKey('contains space')).toThrow(IdempotencyKeyValidationError);
    expect(() => parseIdempotencyKey('x'.repeat(161))).toThrow(IdempotencyKeyValidationError);
  });
});
