import {
  CSRF_HEADER_NAME,
  createApiSecurityHeaders,
  isOriginAllowed,
} from '@geo-content-os/security';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Redis } from 'ioredis';

import { registerCsrfHook } from './csrf-hook.js';
import { registerRateLimitHook } from './rate-limiter.js';
import type { ApiSecurityConfiguration } from './security.config.js';

export async function registerApiSecurityMiddleware(
  application: NestFastifyApplication,
  configuration: ApiSecurityConfiguration,
): Promise<void> {
  const server = application.getHttpAdapter().getInstance();
  const ownedRedis = configuration.rateLimitRedisUrl
    ? new Redis(configuration.rateLimitRedisUrl, {
        enableOfflineQueue: false,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      })
    : undefined;

  if (ownedRedis) {
    await ownedRedis.connect();
    server.addHook('onClose', async () => {
      ownedRedis.disconnect(false);
    });
  }

  await application.register(fastifyCookie, { hook: 'onRequest' });
  await application.register(fastifyCors, {
    allowedHeaders: [
      'authorization',
      'baggage',
      'content-type',
      CSRF_HEADER_NAME,
      'idempotency-key',
      'traceparent',
      'x-request-id',
    ],
    credentials: true,
    exposedHeaders: ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-request-id'],
    maxAge: 600,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    origin(origin, callback) {
      callback(null, isOriginAllowed(origin, configuration.allowedOrigins));
    },
    strictPreflight: true,
  });
  await application.register(fastifyHelmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    hsts: false,
  });

  const headers = createApiSecurityHeaders({ production: configuration.production });
  server.addHook('onSend', (request, reply, payload, done) => {
    for (const [name, value] of Object.entries(headers)) reply.header(name, value);
    reply.header('Cache-Control', 'no-store');
    done(null, payload);
  });

  registerRateLimitHook(server, configuration, ownedRedis);
  registerCsrfHook(server);
}
