export interface KnowledgeWorkerConfig {
  readonly clamAvHost: string;
  readonly clamAvPort: number;
  readonly databaseUrl: string;
  readonly healthPort: number;
  readonly queueConcurrency: number;
  readonly redisUrl: string;
}

export function readKnowledgeWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): KnowledgeWorkerConfig {
  return Object.freeze({
    clamAvHost: required(environment['CLAMAV_HOST'], 'CLAMAV_HOST'),
    clamAvPort: port(environment['CLAMAV_PORT'], 3310, 'CLAMAV_PORT'),
    databaseUrl: required(environment['DATABASE_URL'], 'DATABASE_URL'),
    healthPort: port(environment['HEALTH_PORT'], 9090, 'HEALTH_PORT'),
    queueConcurrency: boundedInteger(
      environment['KNOWLEDGE_WORKER_CONCURRENCY'],
      2,
      'KNOWLEDGE_WORKER_CONCURRENCY',
    ),
    redisUrl: required(environment['REDIS_URL'], 'REDIS_URL'),
  });
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function boundedInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error(`${name} must be an integer between 1 and 100`);
  }
  return parsed;
}

function port(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return parsed;
}
