import { API_BASE_PATH } from '@geo-content-os/contracts';
import {
  redisUrl,
  startRedisTestContainer,
  type StartedTestContainer,
} from '@geo-content-os/testkit';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApplication } from '../../src/application.js';

describe('Redis-backed security rate limit', () => {
  let application: NestFastifyApplication | undefined;
  let redis: StartedTestContainer | undefined;

  beforeAll(async () => {
    redis = await startRedisTestContainer();
    application = await createApplication({
      enableShutdownHooks: false,
      logger: false,
      securityConfiguration: {
        allowedOrigins: ['https://app.example.com'],
        environment: 'test',
        production: false,
        rateLimit: { max: 2, timeWindowMs: 60_000 },
        rateLimitRedisUrl: redisUrl(redis),
        trustProxy: false,
      },
    });
    application
      .getHttpAdapter()
      .getInstance()
      .get(`${API_BASE_PATH}/redis-rate-probe`, async () => ({ ok: true }));
    await application.init();
    await application.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await application?.close();
    await redis?.stop();
  });

  it('shares an atomic fixed-window counter without storing the raw client IP', async () => {
    if (!application || !redis) throw new Error('Security integration fixture was not initialized');

    const responses = [];
    for (let index = 0; index < 3; index += 1) {
      responses.push(
        await application.inject({ method: 'GET', url: `${API_BASE_PATH}/redis-rate-probe` }),
      );
    }

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 429]);
    expect(responses[0]?.headers['x-ratelimit-remaining']).toBe('1');
    expect(responses[1]?.headers['x-ratelimit-remaining']).toBe('0');
    expect(responses[2]?.headers['retry-after']).toBeDefined();
    expect(responses[2]?.json()).toMatchObject({
      error: { code: 'RATE_LIMITED', request_id: expect.any(String) },
    });

    const keys = await redis.exec(['redis-cli', '--raw', 'KEYS', 'geo:rate-limit:*']);
    expect(keys.output).toContain('geo:rate-limit:');
    expect(keys.output).not.toContain('127.0.0.1');
  });
});
