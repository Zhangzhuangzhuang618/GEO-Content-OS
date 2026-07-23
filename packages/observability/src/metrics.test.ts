import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';

import {
  createPrometheusMetricsHandler,
  GeoMetricsRegistry,
  OBSERVABILITY_METRIC_NAMES,
  PROMETHEUS_CONTENT_TYPE,
} from './metrics.js';

describe('GeoMetricsRegistry', () => {
  it('renders the frozen API, queue, AI, publish, audit, and outbox signals', () => {
    const registry = new GeoMetricsRegistry();
    registry.recordApiRequest({
      latencyMs: 800,
      method: 'get',
      route: '/api/v1/content-packages/:id',
      statusCode: 200,
    });
    registry.setQueueSnapshot({
      activeJobs: 3,
      failedJobs: 2,
      lagJobs: 1_001,
      oldestJobAgeSeconds: 301,
      queue: 'geo-ai',
    });
    registry.recordQueueRetry('geo-ai', 2);
    registry.recordQueueLeaseRecovery('geo-outbox', 1);
    registry.recordAiUsage({
      costCents: 15,
      model: 'flash',
      provider: 'deepseek',
      schemaResult: 'repaired',
      skill: 'content-writer',
    });
    registry.recordPublishAttempt({ platform: 'official_site', status: 'success' });
    registry.recordPublishAttempt({ platform: 'official_site', status: 'unknown' });
    registry.recordAuditWriteFailure('high');
    registry.recordOutboxTerminalFailure('content.package.generation_requested.v1');

    const output = registry.render();
    expect(output).toContain(
      `${OBSERVABILITY_METRIC_NAMES.apiRequests}{method="GET",route="/api/v1/content-packages/:id",status_class="2xx",status_code="200"} 1`,
    );
    expect(output).toContain(
      `${OBSERVABILITY_METRIC_NAMES.apiDuration}_bucket{le="0.8",method="GET",route="/api/v1/content-packages/:id",status_class="2xx",status_code="200"} 1`,
    );
    expect(output).toContain(`${OBSERVABILITY_METRIC_NAMES.queueLag}{queue="geo-ai"} 1001`);
    expect(output).toContain(
      `${OBSERVABILITY_METRIC_NAMES.aiCost}{model="flash",provider="deepseek",skill="content-writer"} 15`,
    );
    expect(output).toContain(
      `${OBSERVABILITY_METRIC_NAMES.publishAttempts}{platform="official_site",status="unknown"} 1`,
    );
    expect(output).toContain(`${OBSERVABILITY_METRIC_NAMES.auditWriteFailures}{risk="high"} 1`);
    expect(output).toContain(
      `${OBSERVABILITY_METRIC_NAMES.outboxTerminalFailures}{event_type="content.package.generation_requested.v1"} 1`,
    );
  });

  it('updates queue gauges instead of accumulating snapshots', () => {
    const registry = new GeoMetricsRegistry();
    registry.setQueueSnapshot({
      activeJobs: 2,
      failedJobs: 1,
      lagJobs: 10,
      oldestJobAgeSeconds: 30,
      queue: 'geo-publisher',
    });
    registry.setQueueSnapshot({
      activeJobs: 0,
      failedJobs: 0,
      lagJobs: 1,
      oldestJobAgeSeconds: 3,
      queue: 'geo-publisher',
    });

    const output = registry.render();
    expect(output).toContain(`${OBSERVABILITY_METRIC_NAMES.queueLag}{queue="geo-publisher"} 1`);
    expect(output).not.toContain(
      `${OBSERVABILITY_METRIC_NAMES.queueLag}{queue="geo-publisher"} 10`,
    );
  });

  it('rejects invalid values before they reach Prometheus', () => {
    const registry = new GeoMetricsRegistry();
    expect(() =>
      registry.recordApiRequest({
        latencyMs: -1,
        method: 'GET',
        route: '/api/v1/health',
        statusCode: 200,
      }),
    ).toThrow('latencyMs must be a non-negative finite number');
    expect(() =>
      registry.recordAiUsage({
        costCents: 0.5,
        model: 'flash',
        provider: 'deepseek',
        schemaResult: 'success',
        skill: 'content-writer',
      }),
    ).toThrow('costCents must be a non-negative safe integer');
  });

  it('serves the Prometheus exposition endpoint without exposing other paths', async () => {
    const registry = new GeoMetricsRegistry();
    registry.recordPublishAttempt({ platform: 'zhihu', status: 'success' });
    const server = createServer(createPrometheusMetricsHandler(registry));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not start');

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/metrics`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(PROMETHEUS_CONTENT_TYPE);
      await expect(response.text()).resolves.toContain(
        `${OBSERVABILITY_METRIC_NAMES.publishAttempts}{platform="zhihu",status="success"} 1`,
      );
      await expect(fetch(`http://127.0.0.1:${address.port}/health`)).resolves.toMatchObject({
        status: 404,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
