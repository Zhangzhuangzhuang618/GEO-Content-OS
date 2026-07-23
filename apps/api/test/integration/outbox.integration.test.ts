import {
  deterministicUuid,
  redisUrl,
  startPostgresTestContainer,
  startRedisTestContainer,
  type StartedPostgreSqlContainer,
  type StartedTestContainer,
} from '@geo-content-os/testkit';
import {
  BullMqEventPublisher,
  OutboxRelay,
  OutboxRelayStore,
} from '@geo-content-os/worker-outbox-relay';
import {
  initializeTelemetryContextManager,
  runWithExtractedTraceContext,
} from '@geo-content-os/observability';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import { OutboxWriter } from '../../src/modules/outbox/outbox.writer.js';

describe('transactional outbox and BullMQ relay', () => {
  let postgresContainer: StartedPostgreSqlContainer | undefined;
  let redisContainer: StartedTestContainer | undefined;
  let client: Sql | undefined;
  let writer: OutboxWriter | undefined;

  beforeAll(async () => {
    initializeTelemetryContextManager();
    [postgresContainer, redisContainer] = await Promise.all([
      startPostgresTestContainer(),
      startRedisTestContainer(),
    ]);
    await migrateDatabase(postgresContainer.getConnectionUri());
    client = postgres(postgresContainer.getConnectionUri(), { max: 10, prepare: false });
    writer = new OutboxWriter(client);
  }, 120_000);

  beforeEach(async () => {
    await requiredClient()`TRUNCATE TABLE outbox_events`;
    await redisContainer?.exec(['redis-cli', 'FLUSHALL']);
  });

  afterAll(async () => {
    await client?.end();
    await Promise.all([postgresContainer?.stop(), redisContainer?.stop()]);
  });

  it('commits domain work and event together and protects the immutable payload', async () => {
    const database = requiredClient();
    const outboxWriter = requiredWriter();

    await expect(
      database.begin(async (transaction) => {
        await outboxWriter.enqueue(eventInput(1), transaction);
        throw new Error('roll back business transaction');
      }),
    ).rejects.toThrow('roll back business transaction');

    const emptyRows = await database<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM outbox_events
    `;
    expect(emptyRows[0]?.count).toBe(0);

    const event = await database.begin((transaction) =>
      outboxWriter.enqueue(eventInput(2), transaction),
    );
    const rows = await database<{ id: string }[]>`
      SELECT id FROM outbox_events WHERE id = ${event.event_id}::uuid
    `;
    expect(rows).toHaveLength(1);

    await expect(
      database`
        UPDATE outbox_events
        SET payload_json = jsonb_set(payload_json, '{data,tampered}', 'true')
        WHERE id = ${event.event_id}::uuid
      `,
    ).rejects.toThrow('outbox event identity and payload are immutable');
  });

  it('uses SKIP LOCKED so concurrent relay owners never claim the same event', async () => {
    const database = requiredClient();
    const outboxWriter = requiredWriter();
    await Promise.all([1, 2, 3, 4].map((sequence) => outboxWriter.enqueue(eventInput(sequence))));

    const store = new OutboxRelayStore(database);
    const [first, second] = await Promise.all([
      store.claimBatch('relay-a', 2),
      store.claimBatch('relay-b', 2),
    ]);
    const allIds = [...first, ...second].map(({ id }) => id);

    expect(allIds).toHaveLength(4);
    expect(new Set(allIds).size).toBe(4);
    expect(first.every(({ lockedBy }) => lockedBy === 'relay-a')).toBe(true);
    expect(second.every(({ lockedBy }) => lockedBy === 'relay-b')).toBe(true);
    await expect(store.markPublished(first[0]!.id, 'relay-b')).resolves.toBe(false);
    await expect(store.markPublished(first[0]!.id, 'relay-a')).resolves.toBe(true);
  });

  it('recovers expired leases and retries or terminally fails under the owning lease', async () => {
    const database = requiredClient();
    const event = await requiredWriter().enqueue(eventInput(5));
    const store = new OutboxRelayStore(database);
    await store.claimBatch('relay-crashed', 1);
    await database`
      UPDATE outbox_events
      SET locked_at = now() - interval '2 minutes'
      WHERE id = ${event.event_id}::uuid
    `;

    await expect(store.releaseExpiredLeases(60_000)).resolves.toBe(1);
    const [reclaimed] = await store.claimBatch('relay-recovery', 1);
    expect(reclaimed?.id).toBe(event.event_id);
    await expect(
      store.markPublishFailure(event.event_id, 'relay-recovery', new Error('redis down'), 3, 1),
    ).resolves.toBe('retry');

    await database`
      UPDATE outbox_events SET attempt_count = 2, next_attempt_at = now()
      WHERE id = ${event.event_id}::uuid
    `;
    await store.claimBatch('relay-final', 1);
    await expect(
      store.markPublishFailure(event.event_id, 'relay-final', 'still down', 3, 1),
    ).resolves.toBe('failed');
  });

  it('publishes with BullMQ jobId equal to outbox event id before acknowledging', async () => {
    if (!redisContainer) {
      throw new Error('Redis test container did not start');
    }

    const event = await requiredWriter().enqueue(eventInput(6));
    const store = new OutboxRelayStore(requiredClient());
    const publisher = new BullMqEventPublisher(redisUrl(redisContainer));
    const relay = new OutboxRelay('relay-integration', store, publisher, {
      batchSize: 10,
      leaseDurationMs: 60_000,
      maximumAttempts: 3,
      retryDelayMs: 10,
    });

    try {
      await expect(
        runWithExtractedTraceContext(
          {
            traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
          },
          { requestId: 'request-outbox-integration' },
          () => relay.runOnce(),
        ),
      ).resolves.toMatchObject({ claimed: 1, published: 1 });
      await expect(
        publisher.hasJob({ eventType: event.event_type, id: event.event_id }),
      ).resolves.toBe(true);
      const telemetryMetadata = await publisher.getJobTelemetryMetadata({
        eventType: event.event_type,
        id: event.event_id,
      });
      expect(telemetryMetadata).toContain('4bf92f3577b34da6a3ce929d0e0e4736');
      expect(telemetryMetadata).toContain('geo.request_id');
      await expect(
        publisher.getJobRetryOptions({ eventType: event.event_type, id: event.event_id }),
      ).resolves.toEqual({
        attempts: 5,
        backoff: { delay: 30_000, type: 'exponential' },
      });
      const rows = await requiredClient()<
        {
          status: string;
          published_at: Date | null;
        }[]
      >`
        SELECT status, published_at FROM outbox_events WHERE id = ${event.event_id}::uuid
      `;
      expect(rows[0]?.status).toBe('published');
      expect(rows[0]?.published_at).toBeInstanceOf(Date);
    } finally {
      await publisher.close();
    }
  });

  function requiredClient(): Sql {
    if (!client) {
      throw new Error('PostgreSQL test client did not start');
    }
    return client;
  }

  function requiredWriter(): OutboxWriter {
    if (!writer) {
      throw new Error('Outbox writer did not start');
    }
    return writer;
  }
});

function eventInput(sequence: number) {
  const aggregateId = deterministicUuid(100 + sequence);
  return {
    aggregateId,
    aggregateType: 'source_document' as const,
    data: { source_id: aggregateId },
    eventType: 'knowledge.source.ingest_requested.v1' as const,
    occurredAt: new Date('2026-07-14T00:00:00.000Z'),
    tenantId: deterministicUuid(1),
  };
}
