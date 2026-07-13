import type { DomainEventEnvelope, EventType } from '@geo-content-os/contracts';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { queueNameFor, type OutboxQueueName } from './queue-router.js';
import type { ClaimedOutboxEvent, EventPublisher } from './types.js';

export class BullMqEventPublisher implements EventPublisher {
  private readonly connection: Redis;
  private readonly queues = new Map<
    OutboxQueueName,
    Queue<DomainEventEnvelope, unknown, EventType>
  >();

  public constructor(redisUrl: string) {
    this.connection = new Redis(redisUrl, {
      enableReadyCheck: true,
      maxRetriesPerRequest: null,
    });
  }

  public async publish(event: ClaimedOutboxEvent): Promise<void> {
    const queue = this.getQueue(queueNameFor(event.eventType));

    await queue.add(event.eventType, event.payload, {
      jobId: event.id,
      removeOnComplete: false,
      removeOnFail: false,
    });
  }

  public async hasJob(event: Pick<ClaimedOutboxEvent, 'eventType' | 'id'>): Promise<boolean> {
    const queue = this.getQueue(queueNameFor(event.eventType));
    return (await queue.getJob(event.id)) !== undefined;
  }

  public async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map(async (queue) => queue.close()));
    await this.connection.quit();
  }

  private getQueue(name: OutboxQueueName): Queue<DomainEventEnvelope, unknown, EventType> {
    const existing = this.queues.get(name);
    if (existing) {
      return existing;
    }

    const queue = new Queue<DomainEventEnvelope, unknown, EventType>(name, {
      connection: this.connection,
    });
    this.queues.set(name, queue);
    return queue;
  }
}
