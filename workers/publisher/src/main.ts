import { createServer } from 'node:http';

import { createStorageAdapter, readStorageConfiguration } from '@geo-content-os/adapter-storage';
import postgres from 'postgres';

import { createPublisherCredentialService, readPublisherWorkerConfig } from './config.js';
import { SevenPlatformPublisher } from './platform.publisher.js';
import { PostgresPublisherStore } from './publisher.store.js';
import { PublisherWorker } from './publisher.worker.js';
import { PublisherQueueConsumer } from './queue.consumer.js';

async function main(): Promise<void> {
  const config = readPublisherWorkerConfig();
  const database = postgres(config.databaseUrl, { max: 5, prepare: false });
  const publisher = new PublisherWorker(
    {
      platform: new SevenPlatformPublisher(),
      storage: createStorageAdapter(readStorageConfiguration()),
      store: new PostgresPublisherStore(database, config.staleAfterMs),
    },
    createPublisherCredentialService(),
  );
  const consumer = new PublisherQueueConsumer(publisher, {
    concurrency: config.queueConcurrency,
    onError: (error) => console.error('Publisher Worker queue error', error),
    redisUrl: config.redisUrl,
  });
  let ready = false;
  const health = createServer((request, response) => {
    const healthy = request.url === '/health/live' || (request.url === '/health/ready' && ready);
    response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: healthy ? 'ok' : 'starting' }));
  });
  health.listen(config.healthPort, '0.0.0.0');

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
      new Promise<void>((resolve, reject) =>
        health.close((error) => (error ? reject(error) : resolve())),
      ),
    ]);
  }
}

await main();
