import {
  parseAllowedOrigins,
  readRateLimitConfiguration,
  type RateLimitConfiguration,
} from '@geo-content-os/security';

export interface ApiSecurityConfiguration {
  readonly allowedOrigins: readonly string[];
  readonly environment: string;
  readonly production: boolean;
  readonly rateLimit: RateLimitConfiguration;
  readonly rateLimitRedisUrl?: string;
  readonly trustProxy: false | number;
}

export function readApiSecurityConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): ApiSecurityConfiguration {
  const runtimeEnvironment = environment['NODE_ENV']?.trim() || 'development';
  const rateLimitRedisUrl = environment['RATE_LIMIT_REDIS_URL']?.trim();
  const allowedOrigins = parseAllowedOrigins(environment['CORS_ALLOWED_ORIGINS'], {
    environment: runtimeEnvironment,
  });
  if (runtimeEnvironment === 'production' && !rateLimitRedisUrl) {
    throw new Error('RATE_LIMIT_REDIS_URL is required in production');
  }

  return Object.freeze({
    allowedOrigins,
    environment: runtimeEnvironment,
    production: runtimeEnvironment === 'production',
    rateLimit: readRateLimitConfiguration(environment),
    ...(rateLimitRedisUrl ? { rateLimitRedisUrl } : {}),
    trustProxy: readTrustProxyHops(environment['TRUST_PROXY_HOPS']),
  });
}

function readTrustProxyHops(value: string | undefined): false | number {
  if (value === undefined || value.trim() === '') return false;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new Error('TRUST_PROXY_HOPS must be an integer between 1 and 10');
  }
  return parsed;
}
