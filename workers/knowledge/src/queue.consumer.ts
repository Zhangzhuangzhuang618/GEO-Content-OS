import type { DomainEventEnvelope } from '@geo-content-os/contracts';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';

import { IngestWorkerError } from './ingest.errors.js';
import type { KnowledgeIngestWorker } from './ingest.worker.js';
import type { KeywordImportWorker } from './keyword-import.worker.js';

export interface KnowledgeQueueConsumerOptions {
  readonly concurrency?: number;
  readonly onError?: (error: Error) => void;
  readonly redisUrl: string;
}

export class KnowledgeQueueConsumer {
  private readonly connection: Redis;
  private readonly worker: Worker<DomainEventEnvelope>;

  public constructor(
    ingest: KnowledgeIngestWorker,
    keywordImport: KeywordImportWorker,
    options: KnowledgeQueueConsumerOptions,
  ) {
    const concurrency = options.concurrency ?? 4;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 100) {
      throw new TypeError('Knowledge queue concurrency is invalid');
    }
    this.connection = new Redis(options.redisUrl, {
      enableReadyCheck: true,
      maxRetriesPerRequest: null,
    });
    this.worker = new Worker<DomainEventEnvelope>(
      'geo-knowledge',
      async (job) => {
        if (job.name === 'strategy.keyword_import.requested.v1') {
          return keywordImport.run(job.data);
        }
        const result = await ingest.run(job.data);
        if (result.disposition === 'busy') {
          throw new IngestWorkerError('INGEST_BUSY', 'Knowledge ingest is already running', {
            retryable: true,
          });
        }
        return result;
      },
      { concurrency, connection: this.connection },
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
