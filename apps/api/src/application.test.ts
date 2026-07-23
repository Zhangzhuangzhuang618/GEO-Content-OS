import { API_BASE_PATH, CONTRACT_VERSION } from '@geo-content-os/contracts';
import { createStructuredLogger } from '@geo-content-os/observability';
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

  it('preserves a safe X-Request-Id and replaces an unsafe value', async () => {
    const preserved = await application.inject({
      headers: { 'x-request-id': 'client-request-123' },
      method: 'GET',
      url: `${API_BASE_PATH}/health/live`,
    });
    const replaced = await application.inject({
      headers: { 'x-request-id': 'unsafe request id' },
      method: 'GET',
      url: `${API_BASE_PATH}/health/live`,
    });
    const replacedShort = await application.inject({
      headers: { 'x-request-id': 'request-1' },
      method: 'GET',
      url: `${API_BASE_PATH}/health/live`,
    });

    expect(preserved.headers['x-request-id']).toBe('client-request-123');
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/u);
    expect(replacedShort.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('emits an HTTP completion log correlated with request and W3C trace IDs', async () => {
    const lines: string[] = [];
    const telemetryApplication = await createApplication({
      enableShutdownHooks: false,
      logger: false,
      telemetryLogger: createStructuredLogger({
        destination: {
          write(chunk) {
            lines.push(String(chunk));
          },
        },
        environment: 'test',
        service: 'api',
      }),
    });

    try {
      await telemetryApplication.init();
      await telemetryApplication.getHttpAdapter().getInstance().ready();
      await telemetryApplication.inject({
        headers: {
          traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
          'x-request-id': 'request-with-trace',
        },
        method: 'GET',
        url: `${API_BASE_PATH}/health/live`,
      });
      await telemetryApplication.inject({
        method: 'GET',
        url: '/missing?token=top-secret',
      });
    } finally {
      await telemetryApplication.close();
    }

    const completion = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record['event'] === 'http.request.completed');
    expect(completion).toMatchObject({
      http_method: 'GET',
      http_route: '/api/v1/health/live',
      http_status: 200,
      request_id: 'request-with-trace',
      trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
    });
    expect(completion?.['latency_ms']).toEqual(expect.any(Number));
    const notFound = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record['http_status'] === 404);
    expect(notFound?.['http_route']).toBe('/missing');
    expect(lines.join('')).not.toContain('top-secret');
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
