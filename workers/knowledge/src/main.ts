import { createServer } from 'node:http';

import {
  createEmbeddingAdapter,
  readEmbeddingConfiguration,
} from '@geo-content-os/adapter-embedding';
import { createOcrAdapter, readOcrConfiguration } from '@geo-content-os/adapter-ocr';
import { createStorageAdapter, readStorageConfiguration } from '@geo-content-os/adapter-storage';
import { readWebFetchConfiguration, SafeWebFetchAdapter } from '@geo-content-os/adapter-web-fetch';
import { MaterialParser } from '@geo-content-os/parsers';
import { Redis } from 'ioredis';
import postgres from 'postgres';

import { readKnowledgeWorkerConfig } from './config.js';
import { RedisEmbeddingCache } from './embedding.cache.js';
import { EmbeddingStore } from './embedding.store.js';
import { EmbeddingWorker } from './embedding.worker.js';
import { PostgresIngestStore } from './ingest.store.js';
import { KnowledgeIngestWorker } from './ingest.worker.js';
import { ClamAvMalwareScanner } from './malware.scanner.js';
import { MaterialIngestParser } from './material.ingest-parser.js';
import { AdapterMaterialLoader } from './material.loader.js';
import { KnowledgeQueueConsumer } from './queue.consumer.js';
import { RuntimeMaterialChunker } from './runtime-material.chunker.js';

async function main(): Promise<void> {
  const config = readKnowledgeWorkerConfig();
  const database = postgres(config.databaseUrl, { max: 5, prepare: false });
  const cacheRedis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const embeddingAdapter = createEmbeddingAdapter(readEmbeddingConfiguration());
  const embedding = new EmbeddingWorker(
    new EmbeddingStore(database),
    new RedisEmbeddingCache(cacheRedis),
    embeddingAdapter,
  );
  const ingest = new KnowledgeIngestWorker(
    new PostgresIngestStore(database),
    new AdapterMaterialLoader(
      createStorageAdapter(readStorageConfiguration()),
      new SafeWebFetchAdapter(readWebFetchConfiguration()),
    ),
    new ClamAvMalwareScanner(config.clamAvHost, config.clamAvPort),
    new MaterialIngestParser(new MaterialParser(), createOcrAdapter(readOcrConfiguration())),
    new RuntimeMaterialChunker(),
    embedding,
  );
  const consumer = new KnowledgeQueueConsumer(ingest, {
    concurrency: config.queueConcurrency,
    onError: (error) => console.error('Knowledge Worker queue error', error),
    redisUrl: config.redisUrl,
  });
  let ready = false;
  const health = createServer((request, response) => {
    const healthy = request.url === '/health/live' || (request.url === '/health/ready' && ready);
    response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        embedding_model_key: embeddingAdapter.modelKey,
        status: healthy ? 'ok' : 'starting',
      }),
    );
  });
  health.listen(config.healthPort, '0.0.0.0');

  try {
    await database`SELECT 1`;
    await cacheRedis.ping();
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
      cacheRedis.quit(),
      database.end({ timeout: 5 }),
      new Promise<void>((resolve, reject) =>
        health.close((error) => (error ? reject(error) : resolve())),
      ),
    ]);
  }
}

await main();
