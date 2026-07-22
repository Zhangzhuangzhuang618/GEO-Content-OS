export type AiModelDriver = 'deepseek' | 'mock';

export interface AiWorkerConfig {
  readonly automation: OfficialSiteAutomationConfig;
  readonly databaseUrl: string;
  readonly driver: AiModelDriver;
  readonly healthPort: number;
  readonly queueConcurrency: number;
  readonly redisUrl: string;
}

export interface OfficialSiteAutomationConfig {
  readonly qualityModelKey: string;
  readonly qualityPromptVersionId: string;
  readonly qualitySkillVersion: string;
  readonly rewriteModelKey: string;
  readonly writerPromptVersionId: string;
  readonly writerSkillVersion: string;
}

export function readAiWorkerConfig(environment = process.env): AiWorkerConfig {
  const driver = readDriver(environment);
  if (environment['NODE_ENV'] === 'production' && driver === 'mock') {
    throw new Error('AI_MODEL_DRIVER=mock is forbidden in production');
  }
  return Object.freeze({
    automation: Object.freeze({
      qualityModelKey: required(
        environment['QUALITY_CHECKER_MODEL_KEY'],
        'QUALITY_CHECKER_MODEL_KEY',
      ),
      qualityPromptVersionId: uuid(
        environment['QUALITY_CHECKER_PROMPT_VERSION_ID'],
        'QUALITY_CHECKER_PROMPT_VERSION_ID',
      ),
      qualitySkillVersion: semver(
        environment['QUALITY_CHECKER_SKILL_VERSION'] ?? '1.0.0',
        'QUALITY_CHECKER_SKILL_VERSION',
      ),
      rewriteModelKey: required(
        environment['CONTENT_MODEL_QUALITY_KEY'],
        'CONTENT_MODEL_QUALITY_KEY',
      ),
      writerPromptVersionId: uuid(
        environment['CONTENT_WRITER_PROMPT_VERSION_ID'],
        'CONTENT_WRITER_PROMPT_VERSION_ID',
      ),
      writerSkillVersion: semver(
        environment['CONTENT_WRITER_SKILL_VERSION'] ?? '1.0.0',
        'CONTENT_WRITER_SKILL_VERSION',
      ),
    }),
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

function uuid(value: string | undefined, name: string): string {
  const normalized = required(value, name);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(normalized)
  ) {
    throw new Error(`${name} must be a UUID`);
  }
  return normalized;
}

function semver(value: string, name: string): string {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)) {
    throw new Error(`${name} must be semantic version`);
  }
  return value;
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
