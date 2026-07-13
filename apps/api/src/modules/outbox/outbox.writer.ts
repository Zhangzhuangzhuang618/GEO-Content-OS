import { DomainEventEnvelopeSchema, type DomainEventEnvelope } from '@geo-content-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { OUTBOX_DATABASE_CLIENT } from './outbox.tokens.js';
import type { EnqueueOutboxEventInput, OutboxSql } from './outbox.types.js';

@Injectable()
export class OutboxWriter {
  public constructor(@Inject(OUTBOX_DATABASE_CLIENT) private readonly client: OutboxSql) {}

  /**
   * Call this method with the transaction SQL object that mutated the aggregate.
   * Omitting `transaction` is only appropriate when the event is the entire transaction.
   */
  public async enqueue(
    input: EnqueueOutboxEventInput,
    transaction: OutboxSql = this.client,
  ): Promise<DomainEventEnvelope> {
    const event = DomainEventEnvelopeSchema.parse({
      event_id: randomUUID(),
      event_type: input.eventType,
      tenant: { id: input.tenantId },
      aggregate: {
        id: input.aggregateId,
        type: input.aggregateType,
      },
      data: input.data,
      occurred_at: normalizeOccurredAt(input.occurredAt),
    });

    await transaction`
      INSERT INTO outbox_events (
        id,
        tenant_id,
        event_type,
        aggregate_type,
        aggregate_id,
        payload_json
      ) VALUES (
        ${event.event_id}::uuid,
        ${event.tenant.id}::uuid,
        ${event.event_type},
        ${event.aggregate.type},
        ${event.aggregate.id}::uuid,
        ${transaction.json(event)}
      )
    `;

    return event;
  }
}

function normalizeOccurredAt(value: Date | string | undefined): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value ?? new Date().toISOString();
}
