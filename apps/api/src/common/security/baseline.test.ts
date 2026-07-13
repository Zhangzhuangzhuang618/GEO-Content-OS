import { API_BASE_PATH } from '@geo-content-os/contracts';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, generateSecureToken } from '@geo-content-os/security';
import fastifyCookie from '@fastify/cookie';
import Fastify from 'fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createApplication } from '../../application.js';
import { registerCsrfHook } from './csrf-hook.js';
import { readApiSecurityConfiguration, type ApiSecurityConfiguration } from './security.config.js';

const applications: NestFastifyApplication[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
});

describe('API security baseline', () => {
  it('fails closed when production CORS is not configured', () => {
    expect(() => readApiSecurityConfiguration({ NODE_ENV: 'production' })).toThrow(
      'CORS_ALLOWED_ORIGINS',
    );
    expect(() => readApiSecurityConfiguration({ TRUST_PROXY_HOPS: 'all' })).toThrow(
      'TRUST_PROXY_HOPS',
    );
    expect(() =>
      readApiSecurityConfiguration({
        CORS_ALLOWED_ORIGINS: 'https://app.example.com',
        NODE_ENV: 'production',
      }),
    ).toThrow('RATE_LIMIT_REDIS_URL');
  });

  it('emits security headers and exact credentialed CORS responses', async () => {
    const application = await startApplication(configuration());
    const allowed = await application.inject({
      headers: { origin: 'https://app.example.com' },
      method: 'GET',
      url: `${API_BASE_PATH}/health/live`,
    });
    const denied = await application.inject({
      headers: { origin: 'https://app.example.com.evil.test' },
      method: 'GET',
      url: `${API_BASE_PATH}/health/live`,
    });

    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    expect(allowed.headers['content-security-policy']).toContain("default-src 'none'");
    expect(allowed.headers['strict-transport-security']).toContain('max-age=63072000');
    expect(allowed.headers['x-content-type-options']).toBe('nosniff');
    expect(allowed.headers['x-frame-options']).toBe('DENY');
    expect(allowed.headers['cache-control']).toBe('no-store');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns the frozen 429 envelope with Retry-After and excludes health probes', async () => {
    const application = await startApplication(configuration({ max: 2, timeWindowMs: 60_000 }));
    const missingResponses = [];
    for (let index = 0; index < 3; index += 1) {
      missingResponses.push(
        await application.inject({ method: 'GET', url: `${API_BASE_PATH}/security-rate-probe` }),
      );
    }
    for (let index = 0; index < 4; index += 1) {
      expect(
        (await application.inject({ method: 'GET', url: `${API_BASE_PATH}/health/live` }))
          .statusCode,
      ).toBe(200);
    }

    expect(missingResponses.map((response) => response.statusCode)).toEqual([200, 200, 429]);
    expect(missingResponses[2]?.headers['retry-after']).toBeDefined();
    expect(missingResponses[2]?.json()).toMatchObject({
      error: {
        code: 'RATE_LIMITED',
        request_id: expect.any(String),
      },
    });
  });

  it('blocks missing or mismatched browser CSRF tokens and permits safe or bearer requests', async () => {
    const server = Fastify({ genReqId: () => 'security-request-id' });
    await server.register(fastifyCookie);
    registerCsrfHook(server);
    server.get('/read', async () => ({ ok: true }));
    server.post('/write', async () => ({ ok: true }));
    await server.ready();

    try {
      const token = generateSecureToken();
      const missing = await server.inject({ method: 'POST', url: '/write' });
      const mismatch = await server.inject({
        headers: {
          cookie: `${CSRF_COOKIE_NAME}=${token}`,
          [CSRF_HEADER_NAME]: generateSecureToken(),
        },
        method: 'POST',
        url: '/write',
      });
      const accepted = await server.inject({
        headers: {
          cookie: `${CSRF_COOKIE_NAME}=${token}`,
          [CSRF_HEADER_NAME]: token,
        },
        method: 'POST',
        url: '/write',
      });
      const bearer = await server.inject({
        headers: { authorization: 'Bearer service-credential' },
        method: 'POST',
        url: '/write',
      });

      expect(missing.statusCode).toBe(403);
      expect(missing.json()).toMatchObject({
        error: { code: 'CSRF_INVALID', request_id: 'security-request-id' },
      });
      expect(mismatch.statusCode).toBe(403);
      expect(accepted.statusCode).toBe(200);
      expect(bearer.statusCode).toBe(200);
      expect((await server.inject({ method: 'GET', url: '/read' })).statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });
});

async function startApplication(
  securityConfiguration: ApiSecurityConfiguration,
): Promise<NestFastifyApplication> {
  const application = await createApplication({
    enableShutdownHooks: false,
    logger: false,
    securityConfiguration,
  });
  applications.push(application);
  application
    .getHttpAdapter()
    .getInstance()
    .get(`${API_BASE_PATH}/security-rate-probe`, async () => ({ ok: true }));
  await application.init();
  await application.getHttpAdapter().getInstance().ready();
  return application;
}

function configuration(
  rateLimit: ApiSecurityConfiguration['rateLimit'] = { max: 120, timeWindowMs: 60_000 },
): ApiSecurityConfiguration {
  return {
    allowedOrigins: ['https://app.example.com'],
    environment: 'production',
    production: true,
    rateLimit,
    trustProxy: false,
  };
}
