import type { DomainEventEnvelope } from '@geo-content-os/contracts';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';

import type { ContentGenerationWorker } from './generation.worker.js';
import type { OfficialSiteAutomation } from './official-site-automation.js';
import type { QualityCheckWorker } from './quality.worker.js';
import type { VisibilityProbeWorker } from './visibility.worker.js';

export interface AiQueueConsumerOptions {
  readonly concurrency: number;
  readonly onError?: (error: Error) => void;
  readonly redisUrl: string;
}

export class AiQueueConsumer {
  private readonly connection: Redis;
  private readonly worker: Worker<DomainEventEnvelope>;

  public constructor(
    generation: ContentGenerationWorker,
    quality: QualityCheckWorker,
    automation: OfficialSiteAutomation,
    visibility: VisibilityProbeWorker,
    options: AiQueueConsumerOptions,
  ) {
    const onError = options.onError ?? (() => undefined);
    this.connection = new Redis(options.redisUrl, {
      enableReadyCheck: true,
      maxRetriesPerRequest: null,
    });
    this.worker = new Worker<DomainEventEnvelope>(
      'geo-ai',
      async (job) => {
        if (job.name === 'content.package.generation_requested.v1') {
          const result = await generation.run(job.data);
          if (result.disposition === 'busy') throw new Error('Generation is already running');
          return result;
        }
        if (job.name === 'content.variant.quality_check_requested.v1') {
          return quality.run(job.data);
        }
        if (job.name === 'content.variant.official_site_rewrite_requested.v1') {
          return automation.runRewrite(job.data);
        }
        if (job.name === 'analytics.visibility.probe_requested.v1') {
          return visibility.run(job.data);
        }
        throw new Error(`AI Worker does not handle ${job.name}`);
      },
      { concurrency: options.concurrency, connection: this.connection },
    );
    this.worker.on('error', onError);
    this.worker.on('failed', (_job, error) => onError(error));
  }

  public async close(): Promise<void> {
    await this.worker.close();
    await this.connection.quit();
  }

  public async ready(): Promise<void> {
    await this.worker.waitUntilReady();
  }
}
