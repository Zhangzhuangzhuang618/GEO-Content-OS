import { createServer } from 'node:http';
import postgres from 'postgres';

import { readAiWorkerConfig } from './config.js';
import { PostgresGenerationStore } from './generation.store.js';
import { ContentGenerationWorker } from './generation.worker.js';
import { AiQueueConsumer } from './queue.consumer.js';
import { QualityCheckWorker } from './quality.worker.js';
import { RuntimeContentWriter } from './runtime-content-writer.js';
import { createRuntimeModels } from './runtime-model.js';
import { RuntimeQualityChecker } from './runtime-quality-checker.js';
import { PostgresUsageRecorder } from './usage-recorder.js';

async function main(): Promise<void> {
  const config = readAiWorkerConfig();
  const database = postgres(config.databaseUrl, { max: 5, prepare: false });
  const adapters = createRuntimeModels(config.driver);
  const usage = new PostgresUsageRecorder(database);
  const writer = new RuntimeContentWriter(database, adapters, (context, modelUsage) =>
    usage.record(context, modelUsage),
  );
  const generation = new ContentGenerationWorker(new PostgresGenerationStore(database), writer);
  const quality = new QualityCheckWorker(
    database,
    new RuntimeQualityChecker(database, adapters, (context, modelUsage) =>
      usage.record(context, modelUsage),
    ),
  );
  const consumer = new AiQueueConsumer(generation, quality, {
    concurrency: config.queueConcurrency,
    onError: (error) => console.error('AI Worker queue error', error),
    redisUrl: config.redisUrl,
  });
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
    ready = true;
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } finally {
    ready = false;
    await Promise.all([
      consumer.close(),
      database.end({ timeout: 5 }),
      new Promise<void>((resolve, reject) => {
        health.close((error) => (error ? reject(error) : resolve()));
      }),
    ]);
  }
}

await main();
