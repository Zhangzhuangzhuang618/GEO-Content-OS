import { describe, expect, it } from 'vitest';

import { readSohuBrowserConfig } from './config.js';

const BASE_ENV = Object.freeze({
  SOHU_BROWSER_GATEWAY_TOKEN: 'x'.repeat(32),
  DATABASE_URL: 'postgresql://localhost/geo',
});

describe('Sohu browser configuration', () => {
  it('requires HTTPS for real Sohu pages', () => {
    expect(() =>
      readSohuBrowserConfig({
        ...BASE_ENV,
        SOHU_EDITOR_URL: 'http://sohu.baidu.com/editor',
      }),
    ).toThrow(/HTTPS/u);
  });

  it('confines simulator URLs to localhost', () => {
    expect(() =>
      readSohuBrowserConfig({
        ...BASE_ENV,
        SOHU_BROWSER_SIMULATOR: 'true',
        SOHU_EDITOR_URL: 'http://example.test/editor',
      }),
    ).toThrow(/localhost/u);
  });

  it('accepts a fully local simulator configuration', () => {
    const config = readSohuBrowserConfig({
      ...BASE_ENV,
      SOHU_BROWSER_SIMULATOR: 'true',
      SOHU_EDITOR_URL: 'http://127.0.0.1:3010/editor',
      SOHU_LOGIN_URL: 'http://127.0.0.1:3010/login',
      SOHU_MANAGE_URL: 'http://127.0.0.1:3010/manage',
    });

    expect(config.simulator).toBe(true);
    expect(config.headless).toBe(true);
  });
});
