import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from '@geo-content-os/security';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { middleware } from './middleware';

describe('web security baseline middleware', () => {
  it('adds nonce CSP, browser hardening headers, no-store, and a CSRF cookie', () => {
    const response = middleware(new NextRequest('https://app.example.com/login'));
    const csp = response.headers.get('content-security-policy');

    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.cookies.get(CSRF_COOKIE_NAME)?.value).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(response.headers.get('set-cookie')).toContain('SameSite=lax');
    expect(response.headers.get('set-cookie')).toContain('Secure');
  });

  it('keeps an existing valid CSRF cookie stable', () => {
    const token = 'a'.repeat(43);
    const request = new NextRequest('http://localhost:3000/', {
      headers: { cookie: `${CSRF_COOKIE_NAME}=${token}` },
    });
    const response = middleware(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/auth-01');
    expect(response.headers.get('content-security-policy')).not.toContain(
      'upgrade-insecure-requests',
    );
    expect(response.headers.get('strict-transport-security')).toBeNull();
    expect(response.cookies.get(CSRF_COOKIE_NAME)).toBeUndefined();
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('sends a returning authenticated browser through automatic tenant entry', () => {
    const request = new NextRequest('http://localhost:3000/', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${'s'.repeat(43)}` },
    });
    const response = middleware(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/auth-02?auto=1');
  });
});
