export interface RateLimitConfiguration {
  readonly max: number;
  readonly timeWindowMs: number;
}

export function readRateLimitConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): RateLimitConfiguration {
  return Object.freeze({
    max: readPositiveInteger(environment['RATE_LIMIT_MAX'], 120, 'RATE_LIMIT_MAX'),
    timeWindowMs: readPositiveInteger(
      environment['RATE_LIMIT_WINDOW_MS'],
      60_000,
      'RATE_LIMIT_WINDOW_MS',
    ),
  });
}

function readPositiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined || value.trim() === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
