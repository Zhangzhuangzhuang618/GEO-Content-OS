import {
  getTelemetryContext,
  initializeTelemetryContextManager,
  type StructuredLogger,
  type TelemetryContext,
} from '@geo-content-os/observability';
import { describe, expect, it, vi } from 'vitest';

import { OutboxRelay } from './relay.js';
import type { OutboxRelayStore } from './store.js';
import type { ClaimedOutboxEvent, EventPublisher } from './types.js';

describe('OutboxRelay telemetry', () => {
  it('correlates queue publishing with request, tenant, job, and run IDs', async () => {
    initializeTelemetryContextManager();
    let observed: TelemetryContext | undefined;
    const event = claimedEvent();
    const store = {
      claimBatch: vi.fn(async () => [event]),
      markPublished: vi.fn(async () => true),
      releaseExpiredLeases: vi.fn(async () => 0),
    } as unknown as OutboxRelayStore;
    const publisher: EventPublisher = {
      close: vi.fn(async () => undefined),
      publish: vi.fn(async () => {
        observed = getTelemetryContext();
      }),
    };
    const logger: StructuredLogger = {
      child: vi.fn(() => logger),
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const relay = new OutboxRelay(
      'relay-test',
      store,
      publisher,
      {
        batchSize: 10,
        leaseDurationMs: 60_000,
        maximumAttempts: 3,
        retryDelayMs: 1_000,
      },
      logger,
    );

    await expect(relay.runOnce()).resolves.toMatchObject({ claimed: 1, published: 1 });
    expect(observed).toMatchObject({
      jobId: event.id,
      requestId: 'request-relay-test',
      runId: 'run-relay-test',
      tenantId: event.tenantId,
    });
    expect(logger.info).toHaveBeenCalledWith(
      'Outbox event published',
      expect.objectContaining({ event: 'queue.outbox.published' }),
    );
  });

  it('reports recovered leases and terminal publish failures with stable alert events', async () => {
    const event = claimedEvent();
    const store = {
      claimBatch: vi.fn(async () => [event]),
      markPublishFailure: vi.fn(async () => 'failed'),
      releaseExpiredLeases: vi.fn(async () => 2),
    } as unknown as OutboxRelayStore;
    const publisher: EventPublisher = {
      close: vi.fn(async () => undefined),
      publish: vi.fn(async () => {
        throw new Error('redis unavailable');
      }),
    };
    const logger: StructuredLogger = {
      child: vi.fn(() => logger),
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const relay = new OutboxRelay(
      'relay-test',
      store,
      publisher,
      {
        batchSize: 10,
        leaseDurationMs: 60_000,
        maximumAttempts: 3,
        retryDelayMs: 1_000,
      },
      logger,
    );

    await expect(relay.runOnce()).resolves.toMatchObject({
      claimed: 1,
      failed: 1,
      recoveredLeases: 2,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Expired outbox leases recovered',
      expect.objectContaining({
        event: 'queue.outbox.leases_recovered',
        recovered_leases: 2,
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'Outbox event exhausted publish attempts',
      expect.any(Error),
      expect.objectContaining({
        alert: 'outbox_terminal_failure',
        event: 'queue.outbox.terminal_failure',
      }),
    );
  });
});

function claimedEvent(): ClaimedOutboxEvent {
  return {
    aggregateId: '00000000-0000-4000-8000-000000000010',
    aggregateType: 'source_document',
    attemptCount: 1,
    createdAt: new Date('2026-07-14T00:00:00.000Z'),
    eventType: 'knowledge.source.ingest_requested.v1',
    id: '00000000-0000-4000-8000-000000000011',
    lastError: null,
    lockedAt: new Date('2026-07-14T00:00:01.000Z'),
    lockedBy: 'relay-test',
    nextAttemptAt: new Date('2026-07-14T00:00:00.000Z'),
    payload: {
      aggregate: {
        id: '00000000-0000-4000-8000-000000000010',
        type: 'source_document',
      },
      data: {
        request_id: 'request-relay-test',
        run_id: 'run-relay-test',
      },
      event_id: '00000000-0000-4000-8000-000000000011',
      event_type: 'knowledge.source.ingest_requested.v1',
      occurred_at: '2026-07-14T00:00:00.000Z',
      tenant: { id: '00000000-0000-4000-8000-000000000001' },
    },
    publishedAt: null,
    status: 'processing',
    tenantId: '00000000-0000-4000-8000-000000000001',
  };
}
