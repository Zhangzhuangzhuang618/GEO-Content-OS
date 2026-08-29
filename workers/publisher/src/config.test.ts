import { describe, expect, it } from 'vitest';

import { createPublisherCredentialService, readPublisherWorkerConfig } from './config.js';

describe('publisher runtime config', () => {
  it('reads the required runtime configuration', () => {
    expect(
      readPublisherWorkerConfig({
        DATABASE_URL: 'postgresql://geo:secret@postgres/geo',
        REDIS_URL: 'redis://redis:6379/0',
      }),
    ).toMatchObject({
      healthPort: 9090,
      lockDurationMs: 600_000,
      queueConcurrency: 1,
      staleAfterMs: 600_000,
    });
  });

  it('accepts aligned publisher lease overrides', () => {
    expect(
      readPublisherWorkerConfig({
        DATABASE_URL: 'postgresql://geo:secret@postgres/geo',
        PUBLISHER_QUEUE_LOCK_DURATION_MS: '720000',
        PUBLISHER_STALE_AFTER_MS: '720000',
        PUBLISHER_WORKER_CONCURRENCY: '1',
        REDIS_URL: 'redis://redis:6379/0',
      }),
    ).toMatchObject({ lockDurationMs: 720_000, queueConcurrency: 1, staleAfterMs: 720_000 });
  });

  it('requires an exact 32-byte credential key', () => {
    expect(() => createPublisherCredentialService({})).toThrow(/required/u);
    expect(() =>
      createPublisherCredentialService({ PUBLISHING_CREDENTIAL_KEY_BASE64: 'not-a-key' }),
    ).toThrow(/32 bytes/u);
    expect(() =>
      createPublisherCredentialService({
        PUBLISHING_CREDENTIAL_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
      }),
    ).not.toThrow();
  });
});
