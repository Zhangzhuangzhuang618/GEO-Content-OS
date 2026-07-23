import { describe, expect, it } from 'vitest';

import { readWebFetchConfiguration } from './web-fetch.config.js';

describe('web fetch configuration', () => {
  it('uses bounded secure defaults', () => {
    expect(readWebFetchConfiguration({})).toEqual({
      allowedHosts: [],
      allowedPorts: [80, 443],
      deniedHosts: [],
      maxBytes: 10 * 1_024 * 1_024,
      maxRedirects: 5,
      timeoutMs: 10_000,
      userAgent: 'GEO-Content-OS-WebFetch/1.0',
    });
  });

  it('parses host and port policies without allowing malformed values', () => {
    expect(
      readWebFetchConfiguration({
        WEB_FETCH_ALLOWED_HOSTS: '.example.com,docs.example.com',
        WEB_FETCH_ALLOWED_PORTS: '443,8443',
        WEB_FETCH_DENIED_HOSTS: 'private.example.com',
      }),
    ).toMatchObject({
      allowedHosts: ['example.com', 'docs.example.com'],
      allowedPorts: [443, 8443],
      deniedHosts: ['private.example.com'],
    });
    expect(() =>
      readWebFetchConfiguration({ WEB_FETCH_ALLOWED_HOSTS: 'https://example.com' }),
    ).toThrow();
    expect(() => readWebFetchConfiguration({ WEB_FETCH_ALLOWED_PORTS: '0,443' })).toThrow();
  });

  it('rejects unbounded size, timeout, redirect, and header settings', () => {
    expect(() => readWebFetchConfiguration({ WEB_FETCH_MAX_BYTES: '999999999' })).toThrow();
    expect(() => readWebFetchConfiguration({ WEB_FETCH_TIMEOUT_MS: '60000' })).toThrow();
    expect(() => readWebFetchConfiguration({ WEB_FETCH_MAX_REDIRECTS: '11' })).toThrow();
    expect(() => readWebFetchConfiguration({ WEB_FETCH_USER_AGENT: 'bad\r\nheader' })).toThrow();
  });
});
