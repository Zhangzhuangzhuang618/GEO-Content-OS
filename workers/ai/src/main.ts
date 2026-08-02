import { createServer } from 'node:http';
import postgres from 'postgres';

import { readAiWorkerConfig } from './config.js';
import { PostgresGenerationStore } from './generation.store.js';
import { ContentGenerationWorker } from './generation.worker.js';
import { GenerationAutomationCoordinator } from './generation-automation.js';
import { BaijiahaoAutomation } from './baijiahao-automation.js';
import { BaijiahaoDailyScheduler } from './baijiahao-daily-scheduler.js';
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

async function main(): Promise<void> {
  const config = readAiWorkerConfig();
  const database = postgres(config.databaseUrl, { max: 5, prepare: false });
  const adapters = createRuntimeModels(config.driver);
  const usage = new PostgresUsageRecorder(database);
  const writer = new RuntimeContentWriter(database, adapters, (context, modelUsage) =>
    usage.record(context, modelUsage),
  );
  const automation = new OfficialSiteAutomation(database, writer, config.automation);
  const baijiahaoAutomation = new BaijiahaoAutomation(database, writer, config.automation);
  const qualityAutomation = new QualityAutomationCoordinator(automation, baijiahaoAutomation);
  const generationAutomation = new GenerationAutomationCoordinator(automation, baijiahaoAutomation);
  const dailyScheduler = new OfficialSiteDailyScheduler(database, config.automation, {
    onError: (error) => console.error('Official-site daily scheduler error', error),
    tickMs: config.dailySchedulerTickMs,
  });
  const baijiahaoDailyScheduler = new BaijiahaoDailyScheduler(database, config.automation, {
    onError: (error) => console.error('Baijiahao daily scheduler error', error),
    tickMs: config.dailySchedulerTickMs,
  });
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
  const consumer = new AiQueueConsumer(
    generation,
    quality,
    automation,
    baijiahaoAutomation,
    visibility,
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
    dailyScheduler.start();
    baijiahaoDailyScheduler.start();
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
      database.end({ timeout: 5 }),
      new Promise<void>((resolve, reject) => {
        health.close((error) => (error ? reject(error) : resolve()));
      }),
    ]);
  }
}

await main();
