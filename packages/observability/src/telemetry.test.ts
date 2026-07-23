import type { DestinationStream } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  getTelemetryContext,
  initializeTelemetryContextManager,
  resolveRequestId,
  runWithTelemetryContext,
  shutdownTelemetryContextManager,
} from './context.js';
import { createStructuredLogger } from './logger.js';
import {
  injectTraceContext,
  runWithExtractedTraceContext,
  type TraceCarrier,
} from './propagation.js';

const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

beforeAll(() => initializeTelemetryContextManager());
afterAll(() => shutdownTelemetryContextManager());

describe('telemetry context', () => {
  it('validates incoming request IDs and generates a safe fallback', () => {
    expect(resolveRequestId('client-request-1')).toBe('client-request-1');
    expect(resolveRequestId('contains spaces')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(resolveRequestId('request-1')).not.toBe('request-1');
    expect(resolveRequestId(['repeated'])).not.toBe('repeated');
  });

  it('preserves W3C trace context and GEO correlation fields across async work', async () => {
    const carrier: TraceCarrier = { baggage: 'vendor.key=preserved', traceparent };
    const observed = await runWithExtractedTraceContext(
      carrier,
      { jobId: 'job-1', requestId: 'request-1', tenantId: 'tenant-1' },
      async () => {
        await Promise.resolve();
        return {
          carrier: injectTraceContext(),
          telemetry: getTelemetryContext(),
        };
      },
    );

    expect(observed.telemetry).toMatchObject({
      jobId: 'job-1',
      requestId: 'request-1',
      spanId: '00f067aa0ba902b7',
      tenantId: 'tenant-1',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    });
    expect(observed.carrier.traceparent).toBe(traceparent);
    expect(observed.carrier.baggage).toContain('geo.request_id=request-1');
    expect(observed.carrier.baggage).toContain('vendor.key=preserved');
  });

  it('isolates concurrent request contexts', async () => {
    const requestIds = await Promise.all(
      ['request-a', 'request-b'].map((requestId) =>
        runWithTelemetryContext({ requestId }, async () => {
          await Promise.resolve();
          return getTelemetryContext().requestId;
        }),
      ),
    );
    expect(requestIds).toEqual(['request-a', 'request-b']);
  });
});

describe('structured logger', () => {
  it('emits one-line JSON with context and recursively redacts sensitive fields', () => {
    const lines: string[] = [];
    const destination: DestinationStream = {
      write(chunk) {
        lines.push(String(chunk));
      },
    };
    const logger = createStructuredLogger({
      destination,
      environment: 'test',
      level: 'debug',
      service: 'telemetry-test',
    });

    runWithTelemetryContext({ requestId: 'request-log', tenantId: 'tenant-log' }, () => {
      logger.info('request completed', {
        event: 'http.request.completed',
        nested: { authorization: 'Bearer secret', safe: 'visible' },
        note: 'Bearer top-secret',
        password: 'secret',
        redis_error: 'redis://default:redis-password@redis.internal:6379/1',
      });
    });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({
      environment: 'test',
      event: 'http.request.completed',
      message: 'request completed',
      password: '[REDACTED]',
      request_id: 'request-log',
      service: 'telemetry-test',
      tenant_id: 'tenant-log',
    });
    expect(record['note']).toBe('Bearer [REDACTED]');
    expect(record['nested']).toEqual({ authorization: '[REDACTED]', safe: 'visible' });
    expect(lines.join('')).not.toContain('redis-password');
  });
});
