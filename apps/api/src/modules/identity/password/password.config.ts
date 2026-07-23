const DEFAULT_RESET_TTL_SECONDS = 60 * 60;
const MAX_RESET_TTL_SECONDS = 24 * 60 * 60;

export interface PasswordConfiguration {
  readonly resetTtlSeconds: number;
}

export function readPasswordConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): PasswordConfiguration {
  const raw = environment['PASSWORD_RESET_TTL_SECONDS']?.trim();
  const resetTtlSeconds = raw ? Number(raw) : DEFAULT_RESET_TTL_SECONDS;
  if (
    !Number.isSafeInteger(resetTtlSeconds) ||
    resetTtlSeconds < 5 * 60 ||
    resetTtlSeconds > MAX_RESET_TTL_SECONDS
  ) {
    throw new Error('PASSWORD_RESET_TTL_SECONDS must be between 300 and 86400 seconds');
  }
  return Object.freeze({ resetTtlSeconds });
}
