import type { DomainEventEnvelope } from '@geo-content-os/contracts';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';

import { PublisherError } from './publisher.errors.js';
import type { PublisherWorker } from './publisher.worker.js';

const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000] as const;

export interface PublisherQueueConsumerOptions {
  readonly concurrency?: number;
  readonly lockDurationMs?: number;
  readonly onError?: (error: Error) => void;
  readonly redisUrl: string;
}

export class PublisherQueueConsumer {
  private readonly connection: Redis;
  private readonly queue: Queue<DomainEventEnvelope>;
  private readonly worker: Worker<DomainEventEnvelope>;

  public constructor(
    private readonly publisher: PublisherWorker,
    options: PublisherQueueConsumerOptions,
  ) {
    const concurrency = options.concurrency ?? 1;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 100) {
      throw new TypeError('Publisher queue concurrency is invalid');
    }
    const lockDuration = options.lockDurationMs ?? 600_000;
    if (!Number.isSafeInteger(lockDuration) || lockDuration < 60_000 || lockDuration > 900_000) {
      throw new TypeError('Publisher queue lock duration is invalid');
    }
    this.connection = new Redis(options.redisUrl, {
      enableReadyCheck: true,
      maxRetriesPerRequest: null,
    });
    this.queue = new Queue<DomainEventEnvelope>('geo-publisher', {
      connection: this.connection,
    });
    this.worker = new Worker<DomainEventEnvelope>(
      'geo-publisher',
      async (job) => {
        const result =
          job.name === 'baijiahao.publication.reconcile_requested.v1' ||
          job.name === 'sohu.publication.reconcile_requested.v1' ||
          job.name === 'lieju.publication.reconcile_requested.v1' ||
          job.name === 'douyin.publication.reconcile_requested.v1'
            ? await this.publisher.reconcileBaijiahao(job.data)
            : await this.publisher.run(job.data);
        if (result.disposition === 'busy') {
          throw new PublisherError('PUBLISHER_BUSY', 'Publish job is already running', true);
        }
        return result;
      },
      {
        concurrency,
        connection: this.connection,
        lockDuration,
        stalledInterval: Math.min(30_000, Math.floor(lockDuration / 2)),
        settings: {
          backoffStrategy: (attemptsMade, type) =>
            type === 'publisher' ? publisherBackoffDelay(attemptsMade) : -1,
        },
      },
    );
    this.worker.on('error', options.onError ?? (() => undefined));
    this.worker.on('failed', (job, error) => {
      if (!job || !shouldRecoverPublisherJob(job, error)) return;
      void this.publisher.recoverQueueFailure(job.data).catch(options.onError ?? (() => undefined));
    });
  }

  public async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
    await this.connection.quit();
  }

  public async ready(): Promise<void> {
    await this.worker.waitUntilReady();
    const failed = await this.queue.getJobs(['failed'], 0, 99, true);
    await Promise.all(
      failed
        .filter((job) => shouldRecoverPublisherJob(job, new Error(job.failedReason)))
        .map((job) => this.publisher.recoverQueueFailure(job.data).then(() => undefined)),
    );
  }
}

export function shouldRecoverPublisherJob(
  job: Pick<Job<DomainEventEnvelope>, 'attemptsMade' | 'name' | 'opts'>,
  error: Error,
): boolean {
  if (job.name !== 'publishing.job.execution_requested.v1') return false;
  const attempts = job.opts.attempts ?? 1;
  return (
    job.attemptsMade >= attempts || /job stalled more than allowable limit/iu.test(error.message)
  );
}

export function publisherBackoffDelay(attemptsMade: number): number {
  return RETRY_DELAYS_MS[attemptsMade - 1] ?? -1;
}
