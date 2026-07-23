import { describe, expect, it } from 'vitest';

import { createRequestUuid } from './request-uuid';

describe('createRequestUuid', () => {
  it('uses the native implementation when the browser exposes it', () => {
    const expected = '11111111-2222-4333-8444-555555555555';
    expect(
      createRequestUuid({
        getRandomValues: (array) => array,
        randomUUID: () => expected,
      }),
    ).toBe(expected);
  });

  it('creates a standards-shaped UUID when randomUUID is unavailable on LAN HTTP', () => {
    expect(
      createRequestUuid({
        getRandomValues: (array) => {
          const bytes = array as unknown as Uint8Array;
          bytes.forEach((_, index) => {
            bytes[index] = index;
          });
          return array;
        },
      }),
    ).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });
});
