import { createServer } from 'node:http';
import postgres from 'postgres';
import {
  createEmbeddingAdapter,
  readEmbeddingConfiguration,
} from '@geo-content-os/adapter-embedding';
import {
  CloudflareWorkersAiImageAdapter,
  readImageProviderConfiguration,
} from '@geo-content-os/adapter-image';
import { createRerankAdapter, readRerankConfiguration } from '@geo-content-os/adapter-rerank';
import { createStorageAdapter, readStorageConfiguration } from '@geo-content-os/adapter-storage';
import { CitationSearchService, HybridSearchRepository } from '@geo-content-os/retrieval';

import { readAiWorkerConfig } from './config.js';
import { PostgresGenerationStore } from './generation.store.js';
import { ContentGenerationWorker } from './generation.worker.js';
import { GenerationAutomationCoordinator } from './generation-automation.js';
import { BaijiahaoAutomation } from './baijiahao-automation.js';
import { BaijiahaoDailyScheduler } from './baijiahao-daily-scheduler.js';
import { BrowserPlatformAutomation } from './browser-platform-automation.js';
import { BrowserPlatformDailyScheduler } from './browser-platform-daily-scheduler.js';
import { OfficialSiteAutomation } from './official-site-automation.js';
import { OfficialSiteDailyScheduler } from './official-site-daily-scheduler.js';
import { AiQueueConsumer } from './queue.consumer.js';
import { QualityCheckWorker } from './quality.worker.js';
import { QualityAutomationCoordinator } from './quality-automation.js';
import { RuntimeContentWriter } from './runtime-content-writer.js';
import { createRuntimeModels } from './runtime-model.js';
import { RuntimeQualityChecker } from './runtime-quality-checker.js';
import { PostgresUsageRecorder } from './usage-recorder.js';
import { VisibilityProbeWorker } from './visibility.worker.js';
import { ArticleImagePlanner } from './media-planner.js';
import { PostgresMediaUsageRecorder } from './media-usage.js';
import { ContentMediaAutomation } from './content-media-automation.js';
import { ContentMediaWorker } from './content-media.worker.js';
import { DailyCitationRetriever } from './daily-citation-retriever.js';

async function main(): Promise<void> {
  const config = readAiWorkerConfig();
  const database = postgres(config.databaseUrl, { max: 5, prepare: false });
  const embedding = createEmbeddingAdapter(
    readEmbeddingConfiguration({
      ...process.env,
      EMBEDDING_DRIVER: process.env['EMBEDDING_DRIVER'] ?? 'local',
      EMBEDDING_MODEL_KEY: process.env['EMBEDDING_MODEL_KEY'] ?? 'embedding-local-ngram-v1',
    }),
  );
  const rerank = createRerankAdapter(
    readRerankConfiguration({
      ...process.env,
      RERANK_DRIVER: process.env['RERANK_DRIVER'] ?? 'local',
      RERANK_MODEL_KEY: process.env['RERANK_MODEL_KEY'] ?? 'rerank-local-ngram-v1',
    }),
  );
  const dailyCitationRetriever = new DailyCitationRetriever(
    embedding,
    new CitationSearchService(new HybridSearchRepository(database), rerank),
  );
  const adapters = createRuntimeModels(config.driver);
  const imageConfiguration = readImageProviderConfiguration();
  const imageProvider = imageConfiguration.provider
    ? new CloudflareWorkersAiImageAdapter(imageConfiguration.provider)
    : null;
  const storage = createStorageAdapter(readStorageConfiguration());
  const usage = new PostgresUsageRecorder(database);
  const mediaUsage = new PostgresMediaUsageRecorder(database);
  const writer = new RuntimeContentWriter(database, adapters, (context, modelUsage) =>
    usage.record(context, modelUsage),
  );
  const automation = new OfficialSiteAutomation(database, writer, config.automation);
  const baijiahaoAutomation = new BaijiahaoAutomation(database, writer, config.automation);
  const browserPlatformAutomation = new BrowserPlatformAutomation(
    database,
    writer,
    config.automation,
  );
  const mediaAutomation = new ContentMediaAutomation(config.media, {
    generationModel: imageConfiguration.provider?.generationModel ?? null,
    inspectionModel: imageConfiguration.provider?.inspectionModel ?? null,
    provider: imageConfiguration.driver === 'cloudflare' ? 'cloudflare' : null,
  });
  const qualityAutomation = new QualityAutomationCoordinator(
    automation,
    baijiahaoAutomation,
    mediaAutomation,
    browserPlatformAutomation,
  );
  const generationAutomation = new GenerationAutomationCoordinator(
    automation,
    baijiahaoAutomation,
    browserPlatformAutomation,
  );
  const dailyScheduler = new OfficialSiteDailyScheduler(
    database,
    config.automation,
    {
      onError: (error) => console.error('Official-site daily scheduler error', error),
      tickMs: config.dailySchedulerTickMs,
    },
    dailyCitationRetriever,
  );
  const baijiahaoDailyScheduler = new BaijiahaoDailyScheduler(
    database,
    config.automation,
    {
      onError: (error) => console.error('Baijiahao daily scheduler error', error),
      tickMs: config.dailySchedulerTickMs,
    },
    dailyCitationRetriever,
  );
  const browserPlatformDailyScheduler = new BrowserPlatformDailyScheduler(
    database,
    config.automation,
    {
      onError: (error) => console.error('Browser platform daily scheduler error', error),
      tickMs: config.dailySchedulerTickMs,
    },
    dailyCitationRetriever,
  );
  const generation = new ContentGenerationWorker(
    new PostgresGenerationStore(database, 60_000, generationAutomation),
    writer,
  );
  const quality = new QualityCheckWorker(
    database,
    new RuntimeQualityChecker(database, adapters, (context, modelUsage) =>
      usage.record(context, modelUsage),
    ),
    qualityAutomation,
  );
  const visibility = new VisibilityProbeWorker(database, adapters);
  const plannerModel = adapters.get(config.media.plannerModelKey);
  if (!plannerModel)
    throw new Error(`Image planner model ${config.media.plannerModelKey} is unavailable`);
  const media = new ContentMediaWorker(
    database,
    new ArticleImagePlanner(plannerModel, (scope, modelUsage) =>
      mediaUsage.recordPlanner(scope, modelUsage),
    ),
    imageProvider,
    storage,
    automation,
    baijiahaoAutomation,
    config.media,
    browserPlatformAutomation,
  );
  const consumer = new AiQueueConsumer(
    generation,
    quality,
    automation,
    baijiahaoAutomation,
    browserPlatformAutomation,
    visibility,
    media,
    {
      concurrency: config.queueConcurrency,
      onError: (error) => console.error('AI Worker queue error', error),
      redisUrl: config.redisUrl,
    },
  );
  let ready = false;

  const health = createServer((request, response) => {
    const healthy = request.url === '/health/live' || (request.url === '/health/ready' && ready);
    response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ model_keys: [...adapters.keys()], status: healthy ? 'ok' : 'starting' }),
    );
  });
  health.listen(config.healthPort, '0.0.0.0');

  const stop = (): void => {
    ready = false;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    await database`SELECT 1`;
    await consumer.ready();
    const recoveredBaijiahaoRuns =
      await baijiahaoAutomation.recoverGeneratedIndependentCandidates();
    if (recoveredBaijiahaoRuns > 0) {
      console.warn('Recovered generated Baijiahao candidates for quality checks', {
        count: recoveredBaijiahaoRuns,
      });
    }
    const recoveredMediaRuns = await media.recoverStaleRuns();
    if (recoveredMediaRuns > 0) {
      console.warn('Recovered stale content media runs', { count: recoveredMediaRuns });
    }
    dailyScheduler.start();
    baijiahaoDailyScheduler.start();
    browserPlatformDailyScheduler.start();
    ready = true;
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } finally {
    ready = false;
    await Promise.all([
      consumer.close(),
      dailyScheduler.stop(),
      baijiahaoDailyScheduler.stop(),
      browserPlatformDailyScheduler.stop(),
      database.end({ timeout: 5 }),
      new Promise<void>((resolve, reject) => {
        health.close((error) => (error ? reject(error) : resolve()));
      }),
    ]);
  }
}

await main();
