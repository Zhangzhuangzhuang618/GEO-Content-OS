import {
  redisUrl,
  startPostgresTestContainer,
  startRedisTestContainer,
  TcpFaultProxy,
  type StartedPostgreSqlContainer,
  type StartedTestContainer,
} from '@geo-content-os/testkit';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BullMqEventPublisher } from '../src/publisher.js';
import { queueNameFor } from '../src/queue-router.js';
import { OutboxRelay } from '../src/relay.js';
import { OutboxRelayStore } from '../src/store.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const EVENT_TYPE = 'knowledge.source.ingest_requested.v1' as const;
const QUEUE_NAME = queueNameFor(EVENT_TYPE);

let postgresContainer: StartedPostgreSqlContainer;
let redisContainer: StartedTestContainer;
let client: postgres.Sql;
let directRedis: Redis;
let queue: Queue;
let proxy: TcpFaultProxy;
let publisher: BullMqEventPublisher;

describe('outbox relay fault recovery', () => {
  beforeAll(async () => {
    [postgresContainer, redisContainer] = await Promise.all([
      startPostgresTestContainer(),
      startRedisTestContainer(),
    ]);
    client = postgres(postgresContainer.getConnectionUri(), { max: 4, prepare: false });
    await createOutboxTable(client);
    directRedis = new Redis(redisUrl(redisContainer), { maxRetriesPerRequest: null });
    queue = new Queue(QUEUE_NAME, { connection: directRedis });
    proxy = await TcpFaultProxy.start({
      host: redisContainer.getHost(),
      port: redisContainer.getMappedPort(6379),
    });
  }, 120_000);

  afterAll(async () => {
    proxy?.enable();
    await Promise.allSettled([publisher?.close()]);
    await Promise.allSettled([queue?.close()]);
    await Promise.allSettled([directRedis?.quit()]);
    await Promise.allSettled([proxy?.close(), client?.end({ timeout: 5 })]);
    await Promise.allSettled([postgresContainer?.stop(), redisContainer?.stop()]);
  });

  it('recovers Redis interruption, expired leases, and failed-event replay without duplicate jobs', async () => {
    const store = new OutboxRelayStore(client);
    const outageEvent = eventFixture('00000000-0000-4000-8000-000000000101');
    publisher = new BullMqEventPublisher(proxy.url, { publishTimeoutMs: 250 });
    await expect(publisher.hasJob(outageEvent)).resolves.toBe(false);
    await insertEvent(client, outageEvent, 'pending', 0);

    proxy.disable();
    const interrupted = await relay('relay-outage', store, publisher).runOnce();
    expect(interrupted).toMatchObject({ claimed: 1, published: 0, retried: 1 });
    await expect(readState(client, outageEvent.id)).resolves.toMatchObject({
      attempt_count: 1,
      status: 'pending',
    });

    proxy.enable();
    await expect(waitForJobLookup(publisher, outageEvent)).resolves.toBe(false);
    await client`UPDATE outbox_events SET next_attempt_at = now() WHERE id = ${outageEvent.id}::uuid`;
    await expect(relay('relay-recovery', store, publisher).runOnce()).resolves.toMatchObject({
      published: 1,
    });
    await expect(readState(client, outageEvent.id)).resolves.toMatchObject({
      status: 'published',
    });

    const leaseEvent = eventFixture('00000000-0000-4000-8000-000000000102');
    await insertEvent(client, leaseEvent, 'pending', 0);
    const [claimed] = await store.claimBatch('relay-before-ack-loss', 1);
    expect(claimed?.id).toBe(leaseEvent.id);
    await publisher.publish(claimed!);
    await client`
      UPDATE outbox_events
      SET locked_at = now() - interval '10 seconds'
      WHERE id = ${leaseEvent.id}::uuid
    `;
    await expect(
      relay('relay-after-ack-loss', store, publisher, 10).runOnce(),
    ).resolves.toMatchObject({
      published: 1,
      recoveredLeases: 1,
    });

    const replayEvent = eventFixture('00000000-0000-4000-8000-000000000103');
    await insertEvent(client, replayEvent, 'failed', 10);
    await expect(store.replayFailed(replayEvent.id)).resolves.toBe(true);
    await expect(readState(client, replayEvent.id)).resolves.toMatchObject({
      attempt_count: 0,
      status: 'pending',
    });
    await expect(relay('relay-manual-replay', store, publisher).runOnce()).resolves.toMatchObject({
      published: 1,
    });
    await expect(store.replayFailed(replayEvent.id)).resolves.toBe(false);

    const jobs = await queue.getJobs(['wait', 'active', 'delayed', 'completed', 'failed']);
    const eventIds = jobs.map((job) => job.id).sort();
    expect(eventIds).toEqual([outageEvent.id, leaseEvent.id, replayEvent.id].sort());
    expect(new Set(eventIds).size).toBe(3);
  }, 30_000);
});

async function waitForJobLookup(
  eventPublisher: BullMqEventPublisher,
  event: ReturnType<typeof eventFixture>,
): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return await eventPublisher.hasJob(event);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('Redis publisher did not reconnect within 5 seconds');
}

function relay(
  owner: string,
  store: OutboxRelayStore,
  publisher: BullMqEventPublisher,
  leaseDurationMs = 60_000,
): OutboxRelay {
  return new OutboxRelay(owner, store, publisher, {
    batchSize: 10,
    leaseDurationMs,
    maximumAttempts: 3,
    retryDelayMs: 1,
  });
}

function eventFixture(id: string) {
  const aggregateId = id.replace(/.$/, '9');
  return {
    eventType: EVENT_TYPE,
    id,
    payload: {
      aggregate: { id: aggregateId, type: 'source_document' as const },
      data: { request_id: id },
      event_id: id,
      event_type: EVENT_TYPE,
      occurred_at: '2026-07-16T00:00:00.000Z',
      tenant: { id: TENANT_ID },
    },
  };
}

async function insertEvent(
  sql: postgres.Sql,
  event: ReturnType<typeof eventFixture>,
  status: 'pending' | 'failed',
  attemptCount: number,
): Promise<void> {
  await sql`
    INSERT INTO outbox_events (
      id, tenant_id, event_type, aggregate_type, aggregate_id,
      payload_json, status, attempt_count
    ) VALUES (
      ${event.id}::uuid,
      ${TENANT_ID}::uuid,
      ${event.eventType},
      ${event.payload.aggregate.type},
      ${event.payload.aggregate.id}::uuid,
      ${sql.json(event.payload)},
      ${status},
      ${attemptCount}
    )
  `;
}

async function readState(sql: postgres.Sql, id: string) {
  const [row] = await sql<{ status: string; attempt_count: number }[]>`
    SELECT status, attempt_count FROM outbox_events WHERE id = ${id}::uuid
  `;
  return row;
}

async function createOutboxTable(sql: postgres.Sql): Promise<void> {
  await sql`
    CREATE TABLE outbox_events (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      event_type varchar(80) NOT NULL,
      aggregate_type varchar(64) NOT NULL,
      aggregate_id uuid NOT NULL,
      payload_json jsonb NOT NULL,
      status varchar(16) NOT NULL DEFAULT 'pending',
      attempt_count smallint NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      locked_at timestamptz,
      locked_by varchar(120),
      last_error text,
      published_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT outbox_status_check
        CHECK (status IN ('pending', 'processing', 'published', 'failed')),
      CONSTRAINT outbox_processing_lease_check CHECK (
        (status = 'processing' AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
        OR (status <> 'processing' AND locked_at IS NULL AND locked_by IS NULL)
      )
    )
  `;
}
