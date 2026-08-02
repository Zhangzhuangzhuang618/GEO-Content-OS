import type { DomainEventEnvelope, EventType } from '@geo-content-os/contracts';
import { Queue, type JobsOptions } from 'bullmq';
import { BullMQOtel } from 'bullmq-otel';
import { Redis } from 'ioredis';

import { queueNameFor, type OutboxQueueName } from './queue-router.js';
import type { ClaimedOutboxEvent, EventPublisher } from './types.js';

export interface BullMqEventPublisherOptions {
  readonly publishTimeoutMs?: number;
}

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
  private readonly publishTimeoutMs: number;

  public constructor(redisUrl: string, options: BullMqEventPublisherOptions = {}) {
    this.publishTimeoutMs = options.publishTimeoutMs ?? 5_000;
    assertPositiveInteger(this.publishTimeoutMs, 'publishTimeoutMs');
    this.connection = new Redis(redisUrl, {
      enableOfflineQueue: false,
      enableReadyCheck: true,
      maxRetriesPerRequest: null,
    });
  }

  public async publish(event: ClaimedOutboxEvent): Promise<void> {
    const queue = this.getQueue(queueNameFor(event.eventType));

    await withTimeout(
      queue.add(event.eventType, event.payload, {
        ...retryOptionsForEvent(event.eventType),
        ...queuePriorityForEvent(event.eventType),
        jobId: event.id,
        removeOnComplete: false,
        removeOnFail: false,
      }),
      this.publishTimeoutMs,
      `Timed out publishing outbox event ${event.id}`,
    );
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

export function retryOptionsForEvent(
  eventType: EventType,
): Pick<JobsOptions, 'attempts' | 'backoff'> {
  if (
    eventType.startsWith('knowledge.source.') ||
    eventType === 'content.package.generation_requested.v1' ||
    eventType === 'content.variant.official_site_rewrite_requested.v1' ||
    eventType === 'content.variant.baijiahao_adaptation_requested.v1' ||
    eventType === 'publishing.job.published.v1' ||
    eventType === 'baijiahao.publication.reconcile_requested.v1'
  ) {
    return { attempts: 5, backoff: { delay: 30_000, type: 'exponential' } };
  }
  if (eventType === 'content.variant.quality_check_requested.v1') {
    return { attempts: 3, backoff: { delay: 30_000, type: 'exponential' } };
  }
  if (eventType === 'publishing.job.execution_requested.v1') {
    return { attempts: 4, backoff: { type: 'publisher' } };
  }
  return {};
}

export function queuePriorityForEvent(eventType: EventType): Pick<JobsOptions, 'priority'> {
  if (eventType === 'content.variant.quality_check_requested.v1') {
    return { priority: 1 };
  }
  if (
    eventType === 'content.variant.official_site_rewrite_requested.v1' ||
    eventType === 'content.variant.baijiahao_adaptation_requested.v1'
  ) {
    return { priority: 2 };
  }
  if (eventType === 'content.package.generation_requested.v1') {
    return { priority: 3 };
  }
  return {};
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
