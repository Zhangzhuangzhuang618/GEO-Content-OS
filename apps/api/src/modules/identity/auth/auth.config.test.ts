import { describe, expect, it } from 'vitest';

import { readAuthConfiguration } from './auth.config.js';

describe('auth configuration', () => {
  it('uses bounded frozen session defaults', () => {
    expect(readAuthConfiguration({})).toEqual({
      preAuthCsrfTtlSeconds: 3_600,
      rememberSessionTtlSeconds: 2_592_000,
      sessionTtlSeconds: 28_800,
    });
  });

  it('rejects invalid or unsafe session lifetimes', () => {
    expect(() => readAuthConfiguration({ AUTH_SESSION_TTL_SECONDS: '59' })).toThrow(
      'AUTH_SESSION_TTL_SECONDS',
    );
    expect(() =>
      readAuthConfiguration({
        AUTH_REMEMBER_SESSION_TTL_SECONDS: '3600',
        AUTH_SESSION_TTL_SECONDS: '7200',
      }),
    ).toThrow('AUTH_REMEMBER_SESSION_TTL_SECONDS');
    expect(() =>
      readAuthConfiguration({ AUTH_SESSION_TTL_SECONDS: String(91 * 24 * 60 * 60) }),
    ).toThrow('90 days');
  });
});
