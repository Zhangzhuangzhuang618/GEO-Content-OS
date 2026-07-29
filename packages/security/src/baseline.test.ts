import { describe, expect, it } from 'vitest';

import {
  constantTimeEqual,
  createApiSecurityHeaders,
  createWebSecurityHeaders,
  generateSecureToken,
  isOriginAllowed,
  parseAllowedOrigins,
  readRateLimitConfiguration,
  redactSensitiveData,
  validateDoubleSubmitCsrf,
} from './index.js';

describe('security baseline', () => {
  it('generates unguessable tokens and validates double-submit CSRF', () => {
    const token = generateSecureToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(generateSecureToken()).not.toBe(token);
    expect(constantTimeEqual(token, token)).toBe(true);
    expect(constantTimeEqual(token, `${token}x`)).toBe(false);
    expect(
      validateDoubleSubmitCsrf({ cookieToken: token, headerToken: token, method: 'POST' }),
    ).toEqual({ required: true, valid: true });
    expect(
      validateDoubleSubmitCsrf({ cookieToken: token, headerToken: 'invalid', method: 'PATCH' }),
    ).toEqual({ required: true, valid: false });
    expect(validateDoubleSubmitCsrf({ method: 'GET' })).toEqual({
      required: false,
      valid: true,
    });
    expect(
      validateDoubleSubmitCsrf({ authorization: 'Bearer service-token', method: 'DELETE' }),
    ).toEqual({ required: false, valid: true });
  });

  it('fails closed for production CORS and only matches exact origins', () => {
    expect(() => parseAllowedOrigins(undefined, { environment: 'production' })).toThrow(
      'CORS_ALLOWED_ORIGINS',
    );
    expect(() => parseAllowedOrigins('https://*.example.com')).toThrow('wildcards');
    const origins = parseAllowedOrigins('https://app.example.com, https://admin.example.com');
    expect(isOriginAllowed('https://app.example.com', origins)).toBe(true);
    expect(isOriginAllowed('https://app.example.com.evil.test', origins)).toBe(false);
    expect(isOriginAllowed('null', origins)).toBe(false);
    expect(isOriginAllowed(undefined, origins)).toBe(true);
  });

  it('creates strict API and nonce-based browser security headers', () => {
    const nonce = generateSecureToken();
    const web = createWebSecurityHeaders({ nonce, production: true });
    const api = createApiSecurityHeaders({ production: true });
    expect(web['Content-Security-Policy']).toContain(`script-src 'self' 'nonce-${nonce}'`);
    expect(web['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(web['Content-Security-Policy']).not.toContain("'unsafe-inline'");
    expect(web['Strict-Transport-Security']).toContain('max-age=63072000');
    expect(api['Content-Security-Policy']).toContain("default-src 'none'");
    expect(api['X-Content-Type-Options']).toBe('nosniff');
  });

  it('keeps production CSP strict without upgrading local HTTP assets to HTTPS', () => {
    const web = createWebSecurityHeaders({
      nonce: generateSecureToken(),
      production: true,
      secureTransport: false,
    });

    expect(web['Content-Security-Policy']).not.toContain('upgrade-insecure-requests');
    expect(web['Content-Security-Policy']).not.toContain("'unsafe-eval'");
    expect(web['Strict-Transport-Security']).toBeUndefined();
  });

  it('redacts nested credentials, signed URLs, bearer values, errors, and cycles', () => {
    const cyclic: Record<string, unknown> = { safe: 'visible' };
    cyclic['self'] = cyclic;
    const redacted = redactSensitiveData({
      authorization: 'Bearer top-secret',
      cyclic,
      error: new Error('request?X-Amz-Signature=signature-value'),
      nested: { apiKey: 'secret', safe: 'visible' },
      redisError: 'connect redis://default:redis-password@redis.internal:6379/1 failed',
      url: 'https://storage.test/file?access_token=token-value&part=1',
    });
    expect(redacted).toMatchObject({
      authorization: '[REDACTED]',
      cyclic: { safe: 'visible', self: '[Circular]' },
      nested: { apiKey: '[REDACTED]', safe: 'visible' },
      url: 'https://storage.test/file?access_token=[REDACTED]&part=1',
    });
    expect(JSON.stringify(redacted)).not.toContain('signature-value');
    expect(JSON.stringify(redacted)).not.toContain('token-value');
    expect(JSON.stringify(redacted)).not.toContain('redis-password');
  });

  it('parses bounded positive rate-limit settings', () => {
    expect(readRateLimitConfiguration({})).toEqual({ max: 300, timeWindowMs: 60_000 });
    expect(
      readRateLimitConfiguration({ RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '1000' }),
    ).toEqual({ max: 3, timeWindowMs: 1_000 });
    expect(() => readRateLimitConfiguration({ RATE_LIMIT_MAX: '0' })).toThrow('RATE_LIMIT_MAX');
  });
});
