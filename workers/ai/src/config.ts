export type AiModelDriver = 'deepseek' | 'mock';

export interface AiWorkerConfig {
  readonly automation: OfficialSiteAutomationConfig;
  readonly databaseUrl: string;
  readonly dailySchedulerTickMs: number;
  readonly driver: AiModelDriver;
  readonly healthPort: number;
  readonly media: ContentMediaAutomationConfig;
  readonly queueConcurrency: number;
  readonly redisUrl: string;
}

export interface ContentMediaAutomationConfig {
  readonly enabled: boolean;
  readonly generationSteps: number;
  readonly plannerModelKey: string;
  readonly publicBaseUrl: string | null;
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
    dailySchedulerTickMs: milliseconds(
      environment['OFFICIAL_SITE_DAILY_TICK_MS'],
      30_000,
      'OFFICIAL_SITE_DAILY_TICK_MS',
    ),
    driver,
    healthPort: port(environment['HEALTH_PORT'], 9090, 'HEALTH_PORT'),
    media: Object.freeze({
      enabled: booleanValue(
        environment['IMAGE_AUTOMATION_ENABLED'],
        true,
        'IMAGE_AUTOMATION_ENABLED',
      ),
      generationSteps: boundedInteger(
        environment['IMAGE_GENERATION_STEPS'],
        4,
        'IMAGE_GENERATION_STEPS',
        1,
        8,
      ),
      plannerModelKey: required(
        environment['IMAGE_PLANNER_MODEL_KEY'] ??
          environment['CONTENT_MODEL_BALANCED_KEY'] ??
          'deepseek-v4-flash',
        'IMAGE_PLANNER_MODEL_KEY',
      ),
      publicBaseUrl: publicBaseUrl(environment['GENERATED_MEDIA_PUBLIC_BASE_URL']),
    }),
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

function boundedInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum = 1,
  maximum = 100,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function booleanValue(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function publicBaseUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const parsed = new URL(value.trim());
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      'GENERATED_MEDIA_PUBLIC_BASE_URL must not contain credentials, query, or fragment',
    );
  }
  if (parsed.protocol !== 'https:' && !isLoopback(parsed)) {
    throw new Error('GENERATED_MEDIA_PUBLIC_BASE_URL must use HTTPS outside local development');
  }
  return parsed.toString().replace(/\/$/u, '');
}

function isLoopback(value: URL): boolean {
  return (
    value.protocol === 'http:' &&
    (value.hostname === 'localhost' || value.hostname === '127.0.0.1' || value.hostname === '::1')
  );
}

function port(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return parsed;
}

function milliseconds(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 5_000 || parsed > 300_000) {
    throw new Error(`${name} must be an integer between 5000 and 300000`);
  }
  return parsed;
}
