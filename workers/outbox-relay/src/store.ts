import {
  AggregateTypeSchema,
  DomainEventEnvelopeSchema,
  EventTypeSchema,
  type OutboxStatus,
} from '@geo-content-os/contracts';
import type postgres from 'postgres';

import type { ClaimedOutboxEvent } from './types.js';

interface OutboxRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly event_type: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly payload_json: unknown;
  readonly status: OutboxStatus;
  readonly attempt_count: number;
  readonly next_attempt_at: Date;
  readonly locked_at: Date;
  readonly locked_by: string;
  readonly last_error: string | null;
  readonly published_at: Date | null;
  readonly created_at: Date;
}

export type FailureDisposition = 'retry' | 'failed' | 'lease_lost';

export class OutboxRelayStore {
  public constructor(private readonly client: postgres.Sql) {}

  public async replayFailed(eventId: string): Promise<boolean> {
    const rows = await this.client<{ id: string }[]>`
      UPDATE outbox_events
      SET
        status = 'pending',
        attempt_count = 0,
        next_attempt_at = now(),
        locked_at = NULL,
        locked_by = NULL,
        last_error = NULL,
        published_at = NULL
      WHERE id = ${eventId}::uuid
        AND status = 'failed'
      RETURNING id
    `;

    return rows.length === 1;
  }

  public async releaseExpiredLeases(leaseDurationMs: number): Promise<number> {
    assertPositiveInteger(leaseDurationMs, 'leaseDurationMs');

    const rows = await this.client<{ id: string }[]>`
      UPDATE outbox_events
      SET
        status = 'pending',
        next_attempt_at = now(),
        locked_at = NULL,
        locked_by = NULL,
        last_error = COALESCE(last_error, 'processing lease expired')
      WHERE status = 'processing'
        AND locked_at <= now() - (${leaseDurationMs} * interval '1 millisecond')
      RETURNING id
    `;

    return rows.length;
  }

  public async claimBatch(owner: string, batchSize: number): Promise<ClaimedOutboxEvent[]> {
    assertOwner(owner);
    assertPositiveInteger(batchSize, 'batchSize');
    if (batchSize > 1_000) {
      throw new Error('batchSize must not exceed 1000');
    }

    const rows = await this.client<OutboxRow[]>`
      WITH due AS (
        SELECT id
        FROM outbox_events
        WHERE status = 'pending'
          AND next_attempt_at <= now()
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${batchSize}
      )
      UPDATE outbox_events AS event
      SET
        status = 'processing',
        attempt_count = event.attempt_count + 1,
        locked_at = now(),
        locked_by = ${owner}
      FROM due
      WHERE event.id = due.id
      RETURNING event.*
    `;

    return rows.map(parseClaimedEvent);
  }

  public async markPublished(eventId: string, owner: string): Promise<boolean> {
    assertOwner(owner);
    const rows = await this.client<{ id: string }[]>`
      UPDATE outbox_events
      SET
        status = 'published',
        published_at = now(),
        locked_at = NULL,
        locked_by = NULL,
        last_error = NULL
      WHERE id = ${eventId}::uuid
        AND status = 'processing'
        AND locked_by = ${owner}
      RETURNING id
    `;

    return rows.length === 1;
  }

  public async markPublishFailure(
    eventId: string,
    owner: string,
    error: unknown,
    maximumAttempts: number,
    retryDelayMs: number,
  ): Promise<FailureDisposition> {
    assertOwner(owner);
    assertPositiveInteger(maximumAttempts, 'maximumAttempts');
    assertPositiveInteger(retryDelayMs, 'retryDelayMs');
    const message = formatError(error);

    const rows = await this.client<{ status: OutboxStatus }[]>`
      UPDATE outbox_events
      SET
        status = CASE WHEN attempt_count >= ${maximumAttempts} THEN 'failed' ELSE 'pending' END,
        next_attempt_at = CASE
          WHEN attempt_count >= ${maximumAttempts} THEN next_attempt_at
          ELSE now() + (
            LEAST(
              ${retryDelayMs} * power(2, LEAST(attempt_count - 1, 10)),
              3600000
            ) * interval '1 millisecond'
          )
        END,
        locked_at = NULL,
        locked_by = NULL,
        last_error = ${message}
      WHERE id = ${eventId}::uuid
        AND status = 'processing'
        AND locked_by = ${owner}
      RETURNING status
    `;

    const status = rows[0]?.status;
    if (status === undefined) {
      return 'lease_lost';
    }

    return status === 'failed' ? 'failed' : 'retry';
  }
}

function parseClaimedEvent(row: OutboxRow): ClaimedOutboxEvent {
  const eventType = EventTypeSchema.parse(row.event_type);
  const aggregateType = AggregateTypeSchema.parse(row.aggregate_type);
  const payload = DomainEventEnvelopeSchema.parse(row.payload_json);

  if (
    payload.event_id !== row.id ||
    payload.event_type !== eventType ||
    payload.tenant.id !== row.tenant_id ||
    payload.aggregate.type !== aggregateType ||
    payload.aggregate.id !== row.aggregate_id
  ) {
    throw new Error(`Outbox row ${row.id} does not match its immutable event envelope`);
  }

  return {
    aggregateId: row.aggregate_id,
    aggregateType,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    eventType,
    id: row.id,
    lastError: row.last_error,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    nextAttemptAt: row.next_attempt_at,
    payload,
    publishedAt: row.published_at,
    status: row.status,
    tenantId: row.tenant_id,
  };
}

function assertOwner(owner: string): void {
  if (owner.trim().length === 0 || owner.length > 120) {
    throw new Error('owner must contain between 1 and 120 characters');
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 8_000);
}
