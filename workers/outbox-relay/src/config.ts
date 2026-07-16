import { hostname } from 'node:os';

export interface OutboxRelayConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly owner: string;
  readonly batchSize: number;
  readonly leaseDurationMs: number;
  readonly maximumAttempts: number;
  readonly publishTimeoutMs: number;
  readonly retryDelayMs: number;
  readonly pollIntervalMs: number;
  readonly healthPort: number;
}

export function readOutboxRelayConfig(environment = process.env): OutboxRelayConfig {
  return {
    batchSize: readPositiveInteger(environment['OUTBOX_BATCH_SIZE'], 100, 'OUTBOX_BATCH_SIZE'),
    databaseUrl: readRequired(environment['DATABASE_URL'], 'DATABASE_URL'),
    healthPort: readPositiveInteger(environment['HEALTH_PORT'], 9090, 'HEALTH_PORT'),
    leaseDurationMs: readPositiveInteger(
      environment['OUTBOX_LEASE_DURATION_MS'],
      60_000,
      'OUTBOX_LEASE_DURATION_MS',
    ),
    maximumAttempts: readPositiveInteger(
      environment['OUTBOX_MAXIMUM_ATTEMPTS'],
      10,
      'OUTBOX_MAXIMUM_ATTEMPTS',
    ),
    owner: environment['WORKER_ID']?.trim() || `${hostname()}:${process.pid}`,
    pollIntervalMs: readPositiveInteger(
      environment['OUTBOX_POLL_INTERVAL_MS'],
      1_000,
      'OUTBOX_POLL_INTERVAL_MS',
    ),
    publishTimeoutMs: readPositiveInteger(
      environment['OUTBOX_PUBLISH_TIMEOUT_MS'],
      5_000,
      'OUTBOX_PUBLISH_TIMEOUT_MS',
    ),
    redisUrl: readRequired(environment['REDIS_URL'], 'REDIS_URL'),
    retryDelayMs: readPositiveInteger(
      environment['OUTBOX_RETRY_DELAY_MS'],
      5_000,
      'OUTBOX_RETRY_DELAY_MS',
    ),
  };
}

function readRequired(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function readPositiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}
