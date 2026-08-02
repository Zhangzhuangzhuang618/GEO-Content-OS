import { describe, expect, it } from 'vitest';

import { readBaijiahaoBrowserConfig } from './config.js';

const BASE_ENV = Object.freeze({
  BAIJIAHAO_BROWSER_GATEWAY_TOKEN: 'x'.repeat(32),
  DATABASE_URL: 'postgresql://localhost/geo',
});

describe('Baijiahao browser configuration', () => {
  it('requires HTTPS for real Baijiahao pages', () => {
    expect(() =>
      readBaijiahaoBrowserConfig({
        ...BASE_ENV,
        BAIJIAHAO_EDITOR_URL: 'http://baijiahao.baidu.com/editor',
      }),
    ).toThrow(/HTTPS/u);
  });

  it('confines simulator URLs to localhost', () => {
    expect(() =>
      readBaijiahaoBrowserConfig({
        ...BASE_ENV,
        BAIJIAHAO_BROWSER_SIMULATOR: 'true',
        BAIJIAHAO_EDITOR_URL: 'http://example.test/editor',
      }),
    ).toThrow(/localhost/u);
  });

  it('accepts a fully local simulator configuration', () => {
    const config = readBaijiahaoBrowserConfig({
      ...BASE_ENV,
      BAIJIAHAO_BROWSER_SIMULATOR: 'true',
      BAIJIAHAO_EDITOR_URL: 'http://127.0.0.1:3010/editor',
      BAIJIAHAO_LOGIN_URL: 'http://127.0.0.1:3010/login',
      BAIJIAHAO_MANAGE_URL: 'http://127.0.0.1:3010/manage',
    });

    expect(config.simulator).toBe(true);
    expect(config.headless).toBe(true);
  });
});
