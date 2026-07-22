import { describe, expect, it } from 'vitest';

import { authCookieSecure } from './auth.cookies.js';

describe('auth cookie transport configuration', () => {
  it('defaults to secure cookies and permits an explicit local HTTP override', () => {
    expect(authCookieSecure({})).toBe(true);
    expect(authCookieSecure({ AUTH_COOKIE_SECURE: 'true' })).toBe(true);
    expect(authCookieSecure({ AUTH_COOKIE_SECURE: 'false' })).toBe(false);
  });

  it('rejects ambiguous values', () => {
    expect(() => authCookieSecure({ AUTH_COOKIE_SECURE: 'yes' })).toThrow('AUTH_COOKIE_SECURE');
  });
});
