import { describe, expect, it } from 'vitest';

import { PlatformAccountError } from './platform-account.errors.js';
import { readBaijiahaoBrowserGatewayCredential } from './baijiahao-browser-gateway.client.js';

describe('Baijiahao browser gateway configuration', () => {
  it('reads the internal credential only from server environment values', () => {
    expect(
      readBaijiahaoBrowserGatewayCredential({
        BAIJIAHAO_BROWSER_GATEWAY_BASE_URL: 'http://baijiahao-browser:9095',
        BAIJIAHAO_BROWSER_GATEWAY_TOKEN: 'x'.repeat(32),
      }),
    ).toEqual({
      base_url: 'http://baijiahao-browser:9095/',
      bearer_token: 'x'.repeat(32),
    });
  });

  it('fails closed when the internal token is absent', () => {
    expect(() => readBaijiahaoBrowserGatewayCredential({})).toThrow(PlatformAccountError);
  });
});
