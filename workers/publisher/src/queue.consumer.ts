import type { DomainEventEnvelope } from '@geo-content-os/contracts';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';

import { PublisherError } from './publisher.errors.js';
import type { PublisherWorker } from './publisher.worker.js';

const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000] as const;

export interface PublisherQueueConsumerOptions {
  readonly concurrency?: number;
  readonly onError?: (error: Error) => void;
  readonly redisUrl: string;
}

export class PublisherQueueConsumer {
  private readonly connection: Redis;
  private readonly worker: Worker<DomainEventEnvelope>;

  public constructor(publisher: PublisherWorker, options: PublisherQueueConsumerOptions) {
    const concurrency = options.concurrency ?? 4;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 100) {
      throw new TypeError('Publisher queue concurrency is invalid');
    }
    this.connection = new Redis(options.redisUrl, {
      enableReadyCheck: true,
      maxRetriesPerRequest: null,
    });
    this.worker = new Worker<DomainEventEnvelope>(
      'geo-publisher',
      async (job) => {
        const result =
          job.name === 'baijiahao.publication.reconcile_requested.v1' ||
          job.name === 'sohu.publication.reconcile_requested.v1' ||
          job.name === 'lieju.publication.reconcile_requested.v1' ||
          job.name === 'douyin.publication.reconcile_requested.v1'
            ? await publisher.reconcileBaijiahao(job.data)
            : await publisher.run(job.data);
        if (result.disposition === 'busy') {
          throw new PublisherError('PUBLISHER_BUSY', 'Publish job is already running', true);
        }
        return result;
      },
      {
        concurrency,
        connection: this.connection,
        settings: {
          backoffStrategy: (attemptsMade, type) =>
            type === 'publisher' ? publisherBackoffDelay(attemptsMade) : -1,
        },
      },
    );
    this.worker.on('error', options.onError ?? (() => undefined));
  }

  public async close(): Promise<void> {
    await this.worker.close();
    await this.connection.quit();
  }

  public async ready(): Promise<void> {
    await this.worker.waitUntilReady();
  }
}

export function publisherBackoffDelay(attemptsMade: number): number {
  return RETRY_DELAYS_MS[attemptsMade - 1] ?? -1;
}
