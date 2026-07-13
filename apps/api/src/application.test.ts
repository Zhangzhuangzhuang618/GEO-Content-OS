import { API_BASE_PATH, CONTRACT_VERSION } from '@geo-content-os/contracts';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApplication } from './application.js';
import { readApiRuntimeConfiguration } from './bootstrap.js';
import { HealthService } from './modules/health/health.service.js';

describe('API shell', () => {
  let application: NestFastifyApplication;

  beforeEach(async () => {
    application = await createApplication({
      enableShutdownHooks: false,
      logger: false,
    });
    await application.init();
    await application.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await application.close();
  });

  it('serves liveness under the frozen global prefix', async () => {
    const response = await application.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/health/live`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      service: 'api',
      status: 'ok',
      version: CONTRACT_VERSION,
    });
  });

  it('reports readiness and becomes unavailable during shutdown', async () => {
    const initialResponse = await application.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/health/ready`,
    });
    expect(initialResponse.statusCode).toBe(200);

    application.get(HealthService).beginShutdown();
    const shutdownResponse = await application.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/health/ready`,
    });
    expect(shutdownResponse.statusCode).toBe(503);
    expect(shutdownResponse.json()).toMatchObject({ status: 'not_ready' });
  });

  it('does not expose routes outside /api/v1', async () => {
    const response = await application.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(404);
  });
});

describe('API runtime configuration', () => {
  it('uses stable defaults and accepts a valid port override', () => {
    expect(readApiRuntimeConfiguration({})).toEqual({ host: '0.0.0.0', port: 3_000 });
    expect(readApiRuntimeConfiguration({ API_HOST: '127.0.0.1', PORT: '3100' })).toEqual({
      host: '127.0.0.1',
      port: 3_100,
    });
  });

  it('rejects invalid port values', () => {
    expect(() => readApiRuntimeConfiguration({ PORT: '0' })).toThrow('PORT must be');
    expect(() => readApiRuntimeConfiguration({ PORT: 'not-a-number' })).toThrow('PORT must be');
  });
});
