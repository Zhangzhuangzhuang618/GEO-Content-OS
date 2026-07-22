export type AiModelDriver = 'deepseek' | 'mock';

export interface AiWorkerConfig {
  readonly databaseUrl: string;
  readonly driver: AiModelDriver;
  readonly healthPort: number;
  readonly queueConcurrency: number;
  readonly redisUrl: string;
}

export function readAiWorkerConfig(environment = process.env): AiWorkerConfig {
  const driver = readDriver(environment);
  if (environment['NODE_ENV'] === 'production' && driver === 'mock') {
    throw new Error('AI_MODEL_DRIVER=mock is forbidden in production');
  }
  return Object.freeze({
    databaseUrl: required(environment['DATABASE_URL'], 'DATABASE_URL'),
    driver,
    healthPort: port(environment['HEALTH_PORT'], 9090, 'HEALTH_PORT'),
    queueConcurrency: boundedInteger(
      environment['AI_WORKER_CONCURRENCY'],
      2,
      'AI_WORKER_CONCURRENCY',
    ),
    redisUrl: required(environment['REDIS_URL'], 'REDIS_URL'),
  });
}

function readDriver(environment: NodeJS.ProcessEnv): AiModelDriver {
  const configured = environment['AI_MODEL_DRIVER']?.trim();
  if (configured === 'deepseek' || configured === 'mock') return configured;
  if (configured) throw new Error('AI_MODEL_DRIVER must be deepseek or mock');
  return environment['DEEPSEEK_API_KEY']?.trim() ? 'deepseek' : 'mock';
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
