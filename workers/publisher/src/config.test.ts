import { describe, expect, it } from 'vitest';

import { createPublisherCredentialService, readPublisherWorkerConfig } from './config.js';

describe('publisher runtime config', () => {
  it('validates account-scoped compatible service phones and defaults to none', () => {
    const environment = {
      DATABASE_URL: 'postgresql://localhost/test',
      REDIS_URL: 'redis://localhost:6379',
    };
    const policy = { 'e4ff285d-7df4-4fec-883c-322a1648006a': ['02085627757', '4008372383'] };
    expect(readPublisherWorkerConfig(environment).compatibleServicePhones).toEqual({});
    expect(
      readPublisherWorkerConfig({
        ...environment,
        OFFICIAL_SITE_COMPATIBLE_SERVICE_PHONES_JSON: JSON.stringify(policy),
      }).compatibleServicePhones,
    ).toEqual(policy);
    for (const invalid of [
      'broken-json',
      '{"not-an-account":["02085627757"]}',
      '{"e4ff285d-7df4-4fec-883c-322a1648006a":["invalid"]}',
    ]) {
      expect(() =>
        readPublisherWorkerConfig({
          ...environment,
          OFFICIAL_SITE_COMPATIBLE_SERVICE_PHONES_JSON: invalid,
        }),
      ).toThrow();
    }
  });
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
