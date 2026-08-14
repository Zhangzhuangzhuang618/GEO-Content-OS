import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlatformAccountError } from './platform-account.errors.js';
import {
  readLiejuBrowserGatewayCredential,
  LiejuBrowserGatewayClient,
} from './lieju-browser-gateway.client.js';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000150';
const ENVIRONMENT = {
  LIEJU_BROWSER_GATEWAY_BASE_URL: 'http://lieju-browser:9096',
  LIEJU_BROWSER_GATEWAY_TOKEN: 'x'.repeat(32),
};

describe('Lieju browser gateway configuration', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the internal credential only from server environment values', () => {
    expect(readLiejuBrowserGatewayCredential(ENVIRONMENT)).toEqual({
      base_url: 'http://lieju-browser:9096/',
      bearer_token: 'x'.repeat(32),
    });
  });

  it('fails closed when the internal token is absent', () => {
    expect(() => readLiejuBrowserGatewayCredential({})).toThrow(PlatformAccountError);
  });

  it('preserves a safe attention reason without exposing the upstream message', async () => {
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
      new LiejuBrowserGatewayClient(ENVIRONMENT).login(ACCOUNT_ID),
    ).rejects.toMatchObject({
      code: 'PLATFORM_ACCOUNT_STATE_INVALID',
      details: { reason: 'PAGE_SIGNATURE_CHANGED', upstream_status: 423 },
      message: 'Lieju browser gateway rejected the operation',
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
      new LiejuBrowserGatewayClient(ENVIRONMENT).login(ACCOUNT_ID),
    ).rejects.toMatchObject({
      details: { reason: 'BROWSER_GATEWAY_UNAVAILABLE', upstream_status: 503 },
    });
  });
});
