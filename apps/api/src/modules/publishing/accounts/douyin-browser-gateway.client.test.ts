import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlatformAccountError } from './platform-account.errors.js';
import {
  DouyinBrowserGatewayClient,
  readDouyinBrowserGatewayCredential,
} from './douyin-browser-gateway.client.js';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000158';
const ENVIRONMENT = {
  DOUYIN_BROWSER_GATEWAY_BASE_URL: 'http://douyin-browser:9098',
  DOUYIN_BROWSER_GATEWAY_TOKEN: 'x'.repeat(32),
};

describe('Douyin browser gateway configuration', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the internal credential only from server environment values', () => {
    expect(readDouyinBrowserGatewayCredential(ENVIRONMENT)).toEqual({
      base_url: 'http://douyin-browser:9098/',
      bearer_token: 'x'.repeat(32),
    });
  });

  it('fails closed when the internal token is absent', () => {
    expect(() => readDouyinBrowserGatewayCredential({})).toThrow(PlatformAccountError);
  });

  it('rejects an invalid browser gateway timeout', () => {
    expect(
      () =>
        new DouyinBrowserGatewayClient({
          ...ENVIRONMENT,
          DOUYIN_BROWSER_GATEWAY_TIMEOUT_MS: '999',
        }),
    ).toThrow(/TIMEOUT/u);
  });

  it('preserves a safe attention reason without exposing upstream details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: 'PAGE_SIGNATURE_CHANGED',
              message: 'sensitive creator-center details',
            }),
            { status: 423 },
          ),
      ),
    );

    await expect(
      new DouyinBrowserGatewayClient(ENVIRONMENT).login(ACCOUNT_ID),
    ).rejects.toMatchObject({
      code: 'PLATFORM_ACCOUNT_STATE_INVALID',
      details: { reason: 'PAGE_SIGNATURE_CHANGED', upstream_status: 423 },
      message: 'Douyin browser gateway rejected the operation',
    });
  });

  it('replaces unknown upstream codes with a generic safe reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: 'SECRET_FAILURE', message: 'do not expose' }), {
            status: 503,
          }),
      ),
    );

    await expect(
      new DouyinBrowserGatewayClient(ENVIRONMENT).login(ACCOUNT_ID),
    ).rejects.toMatchObject({
      details: { reason: 'BROWSER_GATEWAY_UNAVAILABLE', upstream_status: 503 },
    });
  });
});
