import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlatformAccountError } from './platform-account.errors.js';
import {
  readSohuBrowserGatewayCredential,
  SohuBrowserGatewayClient,
} from './sohu-browser-gateway.client.js';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000150';
const ENVIRONMENT = {
  SOHU_BROWSER_GATEWAY_BASE_URL: 'http://sohu-browser:9096',
  SOHU_BROWSER_GATEWAY_TOKEN: 'x'.repeat(32),
};

describe('Sohu browser gateway configuration', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the internal credential only from server environment values', () => {
    expect(readSohuBrowserGatewayCredential(ENVIRONMENT)).toEqual({
      base_url: 'http://sohu-browser:9096/',
      bearer_token: 'x'.repeat(32),
    });
  });

  it('fails closed when the internal token is absent', () => {
    expect(() => readSohuBrowserGatewayCredential({})).toThrow(PlatformAccountError);
  });

  it('forwards password input only in the internal request body', async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.body).toBe(
        JSON.stringify({
          accepted_terms: true,
          account: 'publisher@example.com',
          method: 'password',
          password: 'ephemeral-password',
        }),
      );
      expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
      return new Response(JSON.stringify(authenticatedLogin()), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new SohuBrowserGatewayClient(ENVIRONMENT).login(ACCOUNT_ID, {
        accepted_terms: true,
        account: 'publisher@example.com',
        method: 'password',
        password: 'ephemeral-password',
      }),
    ).resolves.toMatchObject({ status: 'authenticated' });
    expect(fetchMock).toHaveBeenCalledOnce();
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

    await expect(new SohuBrowserGatewayClient(ENVIRONMENT).login(ACCOUNT_ID)).rejects.toMatchObject(
      {
        code: 'PLATFORM_ACCOUNT_STATE_INVALID',
        details: { reason: 'PAGE_SIGNATURE_CHANGED', upstream_status: 423 },
        message: 'Sohu browser gateway rejected the operation',
      },
    );
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

    await expect(new SohuBrowserGatewayClient(ENVIRONMENT).login(ACCOUNT_ID)).rejects.toMatchObject(
      {
        details: { reason: 'BROWSER_GATEWAY_UNAVAILABLE', upstream_status: 503 },
      },
    );
  });
});

function authenticatedLogin() {
  return {
    account_id: ACCOUNT_ID,
    authenticated_at: '2026-08-14T08:00:00.000Z',
    last_verified_at: '2026-08-14T08:00:00.000Z',
    qr_expires_at: null,
    status: 'authenticated',
    version: 1,
  };
}
