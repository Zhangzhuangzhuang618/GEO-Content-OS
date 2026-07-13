const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const DEFAULT_REMEMBER_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_PRE_AUTH_CSRF_TTL_SECONDS = 60 * 60;
const MAX_SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;

export interface AuthConfiguration {
  readonly preAuthCsrfTtlSeconds: number;
  readonly rememberSessionTtlSeconds: number;
  readonly sessionTtlSeconds: number;
}

export function readAuthConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): AuthConfiguration {
  const sessionTtlSeconds = readPositiveInteger(
    environment['AUTH_SESSION_TTL_SECONDS'],
    DEFAULT_SESSION_TTL_SECONDS,
    'AUTH_SESSION_TTL_SECONDS',
  );
  const rememberSessionTtlSeconds = readPositiveInteger(
    environment['AUTH_REMEMBER_SESSION_TTL_SECONDS'],
    DEFAULT_REMEMBER_SESSION_TTL_SECONDS,
    'AUTH_REMEMBER_SESSION_TTL_SECONDS',
  );
  const preAuthCsrfTtlSeconds = readPositiveInteger(
    environment['AUTH_PRE_AUTH_CSRF_TTL_SECONDS'],
    DEFAULT_PRE_AUTH_CSRF_TTL_SECONDS,
    'AUTH_PRE_AUTH_CSRF_TTL_SECONDS',
  );

  if (sessionTtlSeconds > MAX_SESSION_TTL_SECONDS) {
    throw new Error('AUTH_SESSION_TTL_SECONDS must not exceed 90 days');
  }
  if (
    rememberSessionTtlSeconds < sessionTtlSeconds ||
    rememberSessionTtlSeconds > MAX_SESSION_TTL_SECONDS
  ) {
    throw new Error(
      'AUTH_REMEMBER_SESSION_TTL_SECONDS must be at least the normal TTL and at most 90 days',
    );
  }

  return Object.freeze({
    preAuthCsrfTtlSeconds,
    rememberSessionTtlSeconds,
    sessionTtlSeconds,
  });
}

function readPositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 60) {
    throw new Error(`${name} must be an integer of at least 60 seconds`);
  }
  return parsed;
}
