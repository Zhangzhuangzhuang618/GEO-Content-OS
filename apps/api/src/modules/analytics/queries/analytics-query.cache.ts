import type { Redis } from 'ioredis';

export interface AnalyticsQueryCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export class RedisAnalyticsQueryCache implements AnalyticsQueryCache {
  public constructor(private readonly redis: Redis) {}

  public get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  public async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.setex(key, ttlSeconds, value);
  }
}
