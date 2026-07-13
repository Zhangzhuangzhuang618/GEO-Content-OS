import { API_BASE_PATH, ERROR_DEFINITIONS } from '@geo-content-os/contracts';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

import type { ApiSecurityConfiguration } from './security.config.js';

const HEALTH_PATH_PREFIX = `${API_BASE_PATH}/health/`;
const REDIS_CONSUME_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`;

interface RateLimitResult {
  readonly count: number;
  readonly retryAfterSeconds: number;
}

interface RateLimitStore {
  consume(key: string, windowMs: number): Promise<RateLimitResult>;
}

export function registerRateLimitHook(
  server: FastifyInstance,
  configuration: ApiSecurityConfiguration,
  redis?: Redis,
): void {
  const store: RateLimitStore = redis ? new RedisRateLimitStore(redis) : new MemoryRateLimitStore();
  const { max, timeWindowMs } = configuration.rateLimit;

  server.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?', 1)[0] ?? '';
    if (path.startsWith(HEALTH_PATH_PREFIX)) return;

    const bucket = Math.floor(Date.now() / timeWindowMs);
    const key = `geo:rate-limit:${bucket}:${hashKey(request.ip)}`;
    const windowEndsAt = (bucket + 1) * timeWindowMs;
    const result = await store.consume(key, Math.max(1, windowEndsAt - Date.now()));
    const remaining = Math.max(0, max - result.count);
    reply.header('X-RateLimit-Limit', String(max));
    reply.header('X-RateLimit-Remaining', String(remaining));
    if (result.count <= max) return;

    reply.header('Retry-After', String(result.retryAfterSeconds));
    await reply.code(ERROR_DEFINITIONS.RATE_LIMITED.httpStatus).send({
      error: {
        code: 'RATE_LIMITED',
        message: ERROR_DEFINITIONS.RATE_LIMITED.message,
        request_id: request.id,
      },
    });
  });
}

class RedisRateLimitStore implements RateLimitStore {
  public constructor(private readonly redis: Redis) {}

  public async consume(key: string, windowMs: number): Promise<RateLimitResult> {
    const response = await this.redis.eval(REDIS_CONSUME_SCRIPT, 1, key, windowMs);
    if (!Array.isArray(response) || response.length !== 2) {
      throw new Error('Redis returned an invalid rate-limit response');
    }
    const count = Number(response[0]);
    const ttl = Number(response[1]);
    if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(ttl)) {
      throw new Error('Redis returned invalid rate-limit counters');
    }
    return { count, retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1_000)) };
  }
}

class MemoryRateLimitStore implements RateLimitStore {
  private readonly counters = new Map<string, { count: number; expiresAt: number }>();

  public async consume(key: string, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const existing = this.counters.get(key);
    const counter =
      existing && existing.expiresAt > now
        ? { count: existing.count + 1, expiresAt: existing.expiresAt }
        : { count: 1, expiresAt: now + windowMs };
    this.counters.set(key, counter);
    if (this.counters.size > 10_000) this.deleteExpired(now);
    return {
      count: counter.count,
      retryAfterSeconds: Math.max(1, Math.ceil((counter.expiresAt - now) / 1_000)),
    };
  }

  private deleteExpired(now: number): void {
    for (const [key, counter] of this.counters) {
      if (counter.expiresAt <= now) this.counters.delete(key);
    }
  }
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
