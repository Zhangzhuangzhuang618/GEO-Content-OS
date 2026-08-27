import { describe, expect, it } from 'vitest';

import { readDouyinBrowserConfig } from './config.js';

const BASE_ENV = Object.freeze({
  DATABASE_URL: 'postgresql://localhost/geo',
  DOUYIN_BROWSER_GATEWAY_TOKEN: 'x'.repeat(32),
});

describe('Douyin browser configuration', () => {
  it('requires HTTPS for real Douyin pages', () => {
    expect(() =>
      readDouyinBrowserConfig({
        ...BASE_ENV,
        DOUYIN_EDITOR_URL: 'http://creator.douyin.com/editor',
      }),
    ).toThrow(/HTTPS/u);
  });

  it('confines simulator URLs to localhost', () => {
    expect(() =>
      readDouyinBrowserConfig({
        ...BASE_ENV,
        DOUYIN_BROWSER_SIMULATOR: 'true',
        DOUYIN_EDITOR_URL: 'http://example.test/editor',
      }),
    ).toThrow(/localhost/u);
  });

  it('uses the image-note upload page by default', () => {
    const config = readDouyinBrowserConfig(BASE_ENV);
    expect(config.editorUrl).toBe('https://creator.douyin.com/creator-micro/content/upload');
    expect(config.healthPort).toBe(9098);
  });
});
