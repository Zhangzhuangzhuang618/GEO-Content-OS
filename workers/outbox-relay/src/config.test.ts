import { describe, expect, it } from 'vitest';

import { readOutboxRelayConfig } from './config.js';

describe('readOutboxRelayConfig', () => {
  it('uses a finite default publish timeout', () => {
    expect(
      readOutboxRelayConfig({
        DATABASE_URL: 'postgres://localhost/geo',
        REDIS_URL: 'redis://localhost:6379/0',
      }).publishTimeoutMs,
    ).toBe(5_000);
  });

  it('rejects a non-positive publish timeout', () => {
    expect(() =>
      readOutboxRelayConfig({
        DATABASE_URL: 'postgres://localhost/geo',
        OUTBOX_PUBLISH_TIMEOUT_MS: '0',
        REDIS_URL: 'redis://localhost:6379/0',
      }),
    ).toThrow('OUTBOX_PUBLISH_TIMEOUT_MS must be a positive integer');
  });
});
