import {
  initializeTelemetryContextManager,
  resolveRequestId,
  runWithExtractedTraceContext,
  type StructuredLogger,
  type TraceCarrier,
} from '@geo-content-os/observability';
import type { FastifyInstance, FastifyRequest } from 'fastify';

interface RequestTiming {
  readonly requestId: string;
  readonly startedAt: bigint;
}

export function registerRequestTelemetry(
  server: FastifyInstance,
  logger: StructuredLogger | undefined,
): void {
  initializeTelemetryContextManager();
  const timings = new WeakMap<FastifyRequest, RequestTiming>();

  server.addHook('onRequest', (request, reply, done) => {
    const requestId = resolveRequestId(request.headers['x-request-id']);
    timings.set(request, { requestId, startedAt: process.hrtime.bigint() });
    reply.header('X-Request-Id', requestId);

    runWithExtractedTraceContext(request.headers as TraceCarrier, { requestId }, () => done());
  });

  server.addHook('onError', (request, _reply, error, done) => {
    const timing = timings.get(request);
    if (!logger || !timing) {
      done();
      return;
    }

    runWithExtractedTraceContext(
      request.headers as TraceCarrier,
      { requestId: timing.requestId },
      () =>
        logger.error('HTTP request failed', error, {
          event: 'http.request.failed',
          http_method: request.method,
          http_route: safeRoute(request),
        }),
    );
    done();
  });

  server.addHook('onResponse', (request, reply, done) => {
    const timing = timings.get(request);
    if (!logger || !timing) {
      done();
      return;
    }

    const latencyMs = Number(process.hrtime.bigint() - timing.startedAt) / 1_000_000;
    runWithExtractedTraceContext(
      request.headers as TraceCarrier,
      { requestId: timing.requestId },
      () =>
        logger.info('HTTP request completed', {
          event: 'http.request.completed',
          http_method: request.method,
          http_route: safeRoute(request),
          http_status: reply.statusCode,
          latency_ms: Number(latencyMs.toFixed(3)),
        }),
    );
    timings.delete(request);
    done();
  });
}

function safeRoute(request: FastifyRequest): string {
  return request.routeOptions.url ?? request.url.split('?', 1)[0] ?? '<unknown>';
}
