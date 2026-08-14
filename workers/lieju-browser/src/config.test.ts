import { describe, expect, it } from 'vitest';

import { readLiejuBrowserConfig } from './config.js';

const BASE_ENV = Object.freeze({
  LIEJU_BROWSER_GATEWAY_TOKEN: 'x'.repeat(32),
  DATABASE_URL: 'postgresql://localhost/geo',
});

describe('Lieju browser configuration', () => {
  it('requires HTTPS for real Lieju pages', () => {
    expect(() =>
      readLiejuBrowserConfig({
        ...BASE_ENV,
        LIEJU_EDITOR_URL: 'http://lieju.baidu.com/editor',
      }),
    ).toThrow(/HTTPS/u);
  });

  it('confines simulator URLs to localhost', () => {
    expect(() =>
      readLiejuBrowserConfig({
        ...BASE_ENV,
        LIEJU_BROWSER_SIMULATOR: 'true',
        LIEJU_EDITOR_URL: 'http://example.test/editor',
      }),
    ).toThrow(/localhost/u);
  });

  it('accepts a fully local simulator configuration', () => {
    const config = readLiejuBrowserConfig({
      ...BASE_ENV,
      LIEJU_BROWSER_SIMULATOR: 'true',
      LIEJU_EDITOR_URL: 'http://127.0.0.1:3010/editor',
      LIEJU_LOGIN_URL: 'http://127.0.0.1:3010/login',
      LIEJU_MANAGE_URL: 'http://127.0.0.1:3010/manage',
    });

    expect(config.simulator).toBe(true);
    expect(config.headless).toBe(true);
  });
});
