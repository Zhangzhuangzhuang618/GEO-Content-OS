import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  isPublicNetworkAddress,
  SafeWebFetchAdapter,
  WebFetchBlockedError,
  WebFetchResponseError,
  WebFetchTimeoutError,
  WebFetchValidationError,
  type WebFetchDependencies,
} from './web-fetch.adapter.js';
import { readWebFetchConfiguration } from './web-fetch.config.js';

describe('SSRF-safe web fetch adapter', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.0.1',
    '198.51.100.1',
    '::1',
    '::ffff:127.0.0.1',
    '64:ff9b::7f00:1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
  ])('classifies %s as non-public', (address) => {
    expect(isPublicNetworkAddress(address)).toBe(false);
  });

  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888'])(
    'classifies %s as public',
    (address) => {
      expect(isPublicNetworkAddress(address)).toBe(true);
    },
  );

  it('rejects credentials, unsafe schemes, local names, unsafe ports, and direct private IPs', async () => {
    const adapter = createAdapter();
    await expect(adapter.fetch('file:///etc/passwd')).rejects.toBeInstanceOf(
      WebFetchValidationError,
    );
    await expect(adapter.fetch('https://user:secret@example.com')).rejects.toBeInstanceOf(
      WebFetchValidationError,
    );
    await expect(adapter.fetch('http://localhost')).rejects.toBeInstanceOf(WebFetchBlockedError);
    await expect(adapter.fetch('http://localhost./admin')).rejects.toBeInstanceOf(
      WebFetchBlockedError,
    );
    await expect(adapter.fetch('http://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(
      WebFetchBlockedError,
    );
    await expect(adapter.fetch('https://example.com:444')).rejects.toBeInstanceOf(
      WebFetchBlockedError,
    );
  });

  it('rejects a hostname if any DNS answer is private and never opens a socket', async () => {
    const request = vi.fn(async () => htmlResponse());
    const adapter = createAdapter({
      lookup: async () => [
        { address: '1.1.1.1', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      request,
    });
    await expect(adapter.fetch('https://rebind.example.com')).rejects.toBeInstanceOf(
      WebFetchBlockedError,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('pins a validated DNS answer and returns a canonical hashed response', async () => {
    const request = vi.fn(
      async (...requestArguments: Parameters<NonNullable<WebFetchDependencies['request']>>) => {
        if (!requestArguments[1]) throw new Error('Expected a pinned address');
        return {
          body: Buffer.from('<html>trusted</html>'),
          headers: { 'content-type': 'text/html; charset=utf-8' },
          statusCode: 200,
        };
      },
    );
    const adapter = createAdapter({ request });
    const result = await adapter.fetch('HTTPS://Example.COM:443/path#fragment');
    expect(request.mock.calls[0]?.[1]).toEqual({ address: '1.1.1.1', family: 4 });
    expect(result).toMatchObject({
      contentHash: createHash('sha256').update('<html>trusted</html>').digest('hex'),
      contentType: 'text/html',
      finalUrl: 'https://example.com/path',
      redirectChain: [],
      statusCode: 200,
    });
  });

  it('revalidates every redirect target and blocks HTTPS downgrade', async () => {
    const request = vi.fn(async (url: URL) =>
      url.hostname === 'example.com'
        ? {
            body: Buffer.alloc(0),
            headers: { location: 'https://127.0.0.1/secret' },
            statusCode: 302,
          }
        : htmlResponse(),
    );
    await expect(createAdapter({ request }).fetch('https://example.com')).rejects.toBeInstanceOf(
      WebFetchBlockedError,
    );
    expect(request).toHaveBeenCalledTimes(1);

    const downgrade = vi.fn(async () => ({
      body: Buffer.alloc(0),
      headers: { location: 'http://public.example.com/page' },
      statusCode: 302,
    }));
    await expect(
      createAdapter({ request: downgrade }).fetch('https://example.com'),
    ).rejects.toBeInstanceOf(WebFetchBlockedError);
  });

  it('resolves the hostname again after a redirect and blocks a DNS rebinding answer', async () => {
    let lookupCount = 0;
    const lookup = vi.fn(async () => {
      lookupCount += 1;
      return lookupCount === 1
        ? [{ address: '1.1.1.1', family: 4 as const }]
        : [{ address: '127.0.0.1', family: 4 as const }];
    });
    const request = vi.fn(async () => ({
      body: Buffer.alloc(0),
      headers: { location: '/second' },
      statusCode: 302,
    }));
    await expect(
      createAdapter({ lookup, request }).fetch('https://example.com/first'),
    ).rejects.toBeInstanceOf(WebFetchBlockedError);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('detects redirect loops, unsupported MIME, status failures, and timeout', async () => {
    const loop = vi.fn(async () => ({
      body: Buffer.alloc(0),
      headers: { location: '/same' },
      statusCode: 302,
    }));
    await expect(
      createAdapter({ request: loop }).fetch('https://example.com/same'),
    ).rejects.toBeInstanceOf(WebFetchResponseError);
    await expect(
      createAdapter({
        request: async () => ({ ...htmlResponse(), headers: { 'content-type': 'image/png' } }),
      }).fetch('https://example.com'),
    ).rejects.toBeInstanceOf(WebFetchResponseError);
    await expect(
      createAdapter({ request: async () => ({ ...htmlResponse(), statusCode: 503 }) }).fetch(
        'https://example.com',
      ),
    ).rejects.toBeInstanceOf(WebFetchResponseError);
    await expect(
      createAdapter({
        request: async () => ({ ...htmlResponse(), body: Buffer.alloc(1025) }),
      }).fetch('https://example.com'),
    ).rejects.toMatchObject({ name: 'WebFetchSizeError' });
    await expect(
      createAdapter(
        { lookup: async () => new Promise(() => undefined) },
        { WEB_FETCH_TIMEOUT_MS: '100' },
      ).fetch('https://example.com'),
    ).rejects.toBeInstanceOf(WebFetchTimeoutError);
  });

  it('enforces allow and deny host policies on the initial URL and redirects', async () => {
    const adapter = createAdapter(
      {},
      {
        WEB_FETCH_ALLOWED_HOSTS: 'example.com',
        WEB_FETCH_DENIED_HOSTS: 'private.example.com',
      },
    );
    await expect(adapter.fetch('https://other.example.org')).rejects.toBeInstanceOf(
      WebFetchBlockedError,
    );
    await expect(adapter.fetch('https://private.example.com')).rejects.toBeInstanceOf(
      WebFetchBlockedError,
    );
    await expect(adapter.fetch('https://docs.example.com')).resolves.toMatchObject({
      statusCode: 200,
    });
  });
});

function createAdapter(
  dependencies: WebFetchDependencies = {},
  environment: NodeJS.ProcessEnv = {},
): SafeWebFetchAdapter {
  return new SafeWebFetchAdapter(
    readWebFetchConfiguration({ WEB_FETCH_MAX_BYTES: '1024', ...environment }),
    {
      lookup: async () => [{ address: '1.1.1.1', family: 4 }],
      request: async () => htmlResponse(),
      ...dependencies,
    },
  );
}

function htmlResponse() {
  return {
    body: Buffer.from('<html>ok</html>'),
    headers: { 'content-type': 'text/html' },
    statusCode: 200,
  };
}
