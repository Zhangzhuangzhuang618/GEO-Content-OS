import { describe, expect, it } from 'vitest';

import { readOcrConfiguration } from './ocr.config.js';

describe('OCR configuration', () => {
  it('uses bounded, production-safe defaults', () => {
    expect(readOcrConfiguration({})).toEqual({
      driver: 'disabled',
      maxBytes: 25 * 1_024 * 1_024,
      maxCharacters: 1_000_000,
      maxPages: 20,
      timeoutMs: 15_000,
    });
  });

  it('accepts explicit bounded mock settings outside production', () => {
    expect(
      readOcrConfiguration({
        NODE_ENV: 'test',
        OCR_DRIVER: 'mock',
        OCR_MAX_BYTES: '1024',
        OCR_MAX_CHARACTERS: '2000',
        OCR_MAX_PAGES: '4',
        OCR_TIMEOUT_MS: '5000',
      }),
    ).toEqual({
      driver: 'mock',
      maxBytes: 1_024,
      maxCharacters: 2_000,
      maxPages: 4,
      timeoutMs: 5_000,
    });
  });

  it('rejects mock production mode, unknown drivers, and unbounded limits', () => {
    expect(() => readOcrConfiguration({ NODE_ENV: 'production', OCR_DRIVER: 'mock' })).toThrow();
    expect(() => readOcrConfiguration({ OCR_DRIVER: 'cloud' })).toThrow();
    expect(() => readOcrConfiguration({ OCR_MAX_BYTES: '0' })).toThrow();
    expect(() => readOcrConfiguration({ OCR_MAX_CHARACTERS: '5000001' })).toThrow();
    expect(() => readOcrConfiguration({ OCR_MAX_PAGES: '101' })).toThrow();
    expect(() => readOcrConfiguration({ OCR_TIMEOUT_MS: '99' })).toThrow();
  });
});
