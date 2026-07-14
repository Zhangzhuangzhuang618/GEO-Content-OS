import type { DomainEventEnvelope, EventType } from '@geo-content-os/contracts';
import { Queue } from 'bullmq';
import { BullMQOtel } from 'bullmq-otel';
import { Redis } from 'ioredis';

import { queueNameFor, type OutboxQueueName } from './queue-router.js';
import type { ClaimedOutboxEvent, EventPublisher } from './types.js';

export class BullMqEventPublisher implements EventPublisher {
  private readonly connection: Redis;
  private readonly telemetry = new BullMQOtel({
    tracerName: 'geo-content-os.outbox-relay',
    version: '0.0.0',
  });
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
      ...(event.eventType.startsWith('knowledge.source.')
        ? { attempts: 5, backoff: { delay: 30_000, type: 'exponential' } }
        : {}),
      jobId: event.id,
      removeOnComplete: false,
      removeOnFail: false,
    });
  }

  public async hasJob(event: Pick<ClaimedOutboxEvent, 'eventType' | 'id'>): Promise<boolean> {
    const queue = this.getQueue(queueNameFor(event.eventType));
    return (await queue.getJob(event.id)) !== undefined;
  }

  public async getJobTelemetryMetadata(
    event: Pick<ClaimedOutboxEvent, 'eventType' | 'id'>,
  ): Promise<string | undefined> {
    const queue = this.getQueue(queueNameFor(event.eventType));
    return (await queue.getJob(event.id))?.opts.telemetry?.metadata;
  }

  public async getJobRetryOptions(
    event: Pick<ClaimedOutboxEvent, 'eventType' | 'id'>,
  ): Promise<{ readonly attempts?: number; readonly backoff?: unknown } | undefined> {
    const queue = this.getQueue(queueNameFor(event.eventType));
    const job = await queue.getJob(event.id);
    if (!job) return undefined;
    return {
      ...(job.opts.attempts === undefined ? {} : { attempts: job.opts.attempts }),
      ...(job.opts.backoff === undefined ? {} : { backoff: job.opts.backoff }),
    };
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
      telemetry: this.telemetry,
    });
    this.queues.set(name, queue);
    return queue;
  }
}
