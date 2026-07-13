import { describe, expect, it } from 'vitest';

import { readPasswordConfiguration } from './password.config.js';

describe('password configuration', () => {
  it('uses a one-hour reset lifetime', () => {
    expect(readPasswordConfiguration({})).toEqual({ resetTtlSeconds: 3_600 });
  });

  it('rejects reset lifetimes outside five minutes to one day', () => {
    expect(() => readPasswordConfiguration({ PASSWORD_RESET_TTL_SECONDS: '299' })).toThrow(
      'PASSWORD_RESET_TTL_SECONDS',
    );
    expect(() => readPasswordConfiguration({ PASSWORD_RESET_TTL_SECONDS: '86401' })).toThrow(
      'PASSWORD_RESET_TTL_SECONDS',
    );
  });
});
