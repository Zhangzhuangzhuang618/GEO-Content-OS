import type { DomainEventEnvelope } from '@geo-content-os/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  IdempotentEventConsumer,
  type EventReceiptKey,
  type EventReceiptStore,
  type IdempotentConsumeResult,
} from './consumer-idempotency.js';

const event: DomainEventEnvelope = {
  event_id: '00000000-0000-4000-8000-000000000011',
  event_type: 'knowledge.source.ingest_requested.v1',
  tenant: { id: '00000000-0000-4000-8000-000000000001' },
  aggregate: {
    type: 'source_document',
    id: '00000000-0000-4000-8000-000000000010',
  },
  data: { source_id: '00000000-0000-4000-8000-000000000010' },
  occurred_at: '2026-07-14T00:00:00.000Z',
};

class MemoryReceiptStore implements EventReceiptStore {
  private readonly receipts = new Set<string>();

  public async executeOnce<TResult>(
    key: EventReceiptKey,
    operation: () => Promise<TResult>,
  ): Promise<IdempotentConsumeResult<TResult>> {
    const receipt = `${key.consumerName}:${key.eventId}:${key.businessKey}`;
    if (this.receipts.has(receipt)) {
      return { outcome: 'duplicate' };
    }

    const value = await operation();
    this.receipts.add(receipt);
    return { outcome: 'processed', value };
  }
}

describe('IdempotentEventConsumer', () => {
  it('processes an event only once for the same event and business key', async () => {
    const handler = vi.fn(async () => 'created');
    const consumer = new IdempotentEventConsumer('knowledge-indexer', new MemoryReceiptStore());

    await expect(consumer.consume(event, 'source:10', handler)).resolves.toEqual({
      outcome: 'processed',
      value: 'created',
    });
    await expect(consumer.consume(event, 'source:10', handler)).resolves.toEqual({
      outcome: 'duplicate',
    });
    expect(handler).toHaveBeenCalledOnce();
  });
});
