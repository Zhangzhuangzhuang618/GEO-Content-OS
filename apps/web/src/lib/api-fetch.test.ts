import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiGet, resetApiGetStateForTests } from './api-fetch';

afterEach(() => {
  resetApiGetStateForTests();
  vi.unstubAllGlobals();
});

describe('apiGet', () => {
  it('deduplicates simultaneous reads and gives each caller an independent body', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = apiGet('/api/v1/auth/tenants');
    const second = apiGet('/api/v1/auth/tenants');
    resolveFetch?.(Response.json({ data: ['tenant'] }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await (await first).json()).toEqual({ data: ['tenant'] });
    expect(await (await second).json()).toEqual({ data: ['tenant'] });
  });

  it('reuses successful lookup responses within the requested cache window', async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: ['workspace'] }));
    vi.stubGlobal('fetch', fetchMock);

    await apiGet('/api/v1/workspaces', { cacheTtlMs: 30_000 });
    await apiGet('/api/v1/workspaces', { cacheTtlMs: 30_000 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('blocks subsequent reads locally for the server Retry-After window', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          headers: { 'Retry-After': '20' },
          status: 429,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect((await apiGet('/api/v1/content-packages')).status).toBe(429);
    const blocked = await apiGet('/api/v1/auth/tenants');

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('20');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
