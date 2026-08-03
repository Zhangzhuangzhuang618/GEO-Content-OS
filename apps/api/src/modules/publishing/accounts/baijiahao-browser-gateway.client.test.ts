import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlatformAccountError } from './platform-account.errors.js';
import {
  BaijiahaoBrowserGatewayClient,
  readBaijiahaoBrowserGatewayCredential,
} from './baijiahao-browser-gateway.client.js';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000145';
const ENVIRONMENT = {
  BAIJIAHAO_BROWSER_GATEWAY_BASE_URL: 'http://baijiahao-browser:9095',
  BAIJIAHAO_BROWSER_GATEWAY_TOKEN: 'x'.repeat(32),
};

describe('Baijiahao browser gateway configuration', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the internal credential only from server environment values', () => {
    expect(readBaijiahaoBrowserGatewayCredential(ENVIRONMENT)).toEqual({
      base_url: 'http://baijiahao-browser:9095/',
      bearer_token: 'x'.repeat(32),
    });
  });

  it('fails closed when the internal token is absent', () => {
    expect(() => readBaijiahaoBrowserGatewayCredential({})).toThrow(PlatformAccountError);
  });

  it('preserves a safe browser failure reason without exposing the upstream message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: 'PAGE_SIGNATURE_CHANGED',
              message: 'sensitive upstream page details',
            }),
            { status: 423 },
          ),
      ),
    );

    await expect(
      new BaijiahaoBrowserGatewayClient(ENVIRONMENT).login(ACCOUNT_ID),
    ).rejects.toMatchObject({
      code: 'PLATFORM_ACCOUNT_STATE_INVALID',
      details: { reason: 'PAGE_SIGNATURE_CHANGED', upstream_status: 423 },
      message: 'Baijiahao browser gateway rejected the operation',
    });
  });

  it('replaces unknown gateway response codes with a generic safe reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ code: 'SECRET_INTERNAL_FAILURE', message: 'do not expose' }),
            {
              status: 503,
            },
          ),
      ),
    );

    await expect(
      new BaijiahaoBrowserGatewayClient(ENVIRONMENT).login(ACCOUNT_ID),
    ).rejects.toMatchObject({
      details: { reason: 'BROWSER_GATEWAY_UNAVAILABLE', upstream_status: 503 },
    });
  });
});
