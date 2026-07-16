import {
  createDatabaseDebugLogger,
  createStructuredLogger,
  initializeTelemetryContextManager,
  shutdownTelemetryContextManager,
} from '@geo-content-os/observability';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import postgres from 'postgres';

import { readOutboxRelayConfig } from './config.js';
import { BullMqEventPublisher } from './publisher.js';
import { OutboxRelay } from './relay.js';
import { OutboxRelayStore } from './store.js';

async function main(): Promise<void> {
  initializeTelemetryContextManager();
  const config = readOutboxRelayConfig();
  const logger = createStructuredLogger({ service: 'outbox-relay' });
  const abortController = new AbortController();
  const client = postgres(config.databaseUrl, {
    debug: createDatabaseDebugLogger(logger),
    max: 5,
    prepare: false,
  });
  const publisher = new BullMqEventPublisher(config.redisUrl, {
    publishTimeoutMs: config.publishTimeoutMs,
  });
  const store = new OutboxRelayStore(client);
  const relay = new OutboxRelay(
    config.owner,
    store,
    publisher,
    {
      batchSize: config.batchSize,
      leaseDurationMs: config.leaseDurationMs,
      maximumAttempts: config.maximumAttempts,
      retryDelayMs: config.retryDelayMs,
    },
    logger,
  );
  let ready = false;

  const healthServer = createServer((request, response) => {
    if (request.url === '/health/live') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"status":"ok"}');
      return;
    }

    if (request.url === '/health/ready' && ready) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"status":"ready"}');
      return;
    }

    response.writeHead(503, { 'content-type': 'application/json' });
    response.end('{"status":"unavailable"}');
  });

  const stop = (): void => {
    ready = false;
    abortController.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  healthServer.listen(config.healthPort, '0.0.0.0');

  try {
    while (!abortController.signal.aborted) {
      try {
        await relay.runOnce();
        ready = true;
      } catch (error) {
        ready = false;
        logger.error('Outbox relay iteration failed', error, {
          event: 'queue.outbox.iteration_failed',
          worker_id: config.owner,
        });
      }

      try {
        await delay(config.pollIntervalMs, undefined, { signal: abortController.signal });
      } catch (error) {
        if (!abortController.signal.aborted) {
          throw error;
        }
      }
    }
  } finally {
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        healthServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
      publisher.close(),
      client.end({ timeout: 5 }),
    ]);
    shutdownTelemetryContextManager();
  }
}

await main();
