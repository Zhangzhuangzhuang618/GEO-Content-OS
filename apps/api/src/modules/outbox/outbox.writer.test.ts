import { describe, expect, it, vi } from 'vitest';

import type { OutboxSql } from './outbox.types.js';
import { OutboxWriter } from './outbox.writer.js';

describe('OutboxWriter', () => {
  it('resolves a lazy database provider only when no transaction is supplied', async () => {
    const client = vi.fn(async () => []) as unknown as OutboxSql;
    const provider = {
      get client(): OutboxSql {
        return client;
      },
    };
    const writer = new OutboxWriter(provider);

    const event = await writer.enqueue({
      aggregateId: '10000000-0000-4000-8000-000000000026',
      aggregateType: 'generation_run',
      data: { project_id: '20000000-0000-4000-8000-000000000026' },
      eventType: 'strategy.topic_plan.generation_requested.v1',
      tenantId: '30000000-0000-4000-8000-000000000026',
    });

    expect(event.aggregate.type).toBe('generation_run');
    expect(client).toHaveBeenCalledOnce();
  });

  it('uses the supplied transaction without resolving the default provider', async () => {
    const transaction = vi.fn(async () => []) as unknown as OutboxSql;
    const provider = {
      get client(): OutboxSql {
        throw new Error('default provider should remain lazy');
      },
    };
    const writer = new OutboxWriter(provider);

    await writer.enqueue(
      {
        aggregateId: '10000000-0000-4000-8000-000000000026',
        aggregateType: 'generation_run',
        data: {},
        eventType: 'strategy.topic_plan.generation_requested.v1',
        tenantId: '30000000-0000-4000-8000-000000000026',
      },
      transaction,
    );

    expect(transaction).toHaveBeenCalledOnce();
  });
});
