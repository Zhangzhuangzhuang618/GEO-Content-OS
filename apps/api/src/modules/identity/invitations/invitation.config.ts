const DEFAULT_INVITATION_TTL_SECONDS = 72 * 60 * 60;
const MAX_INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface InvitationConfiguration {
  readonly ttlSeconds: number;
}

export function readInvitationConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): InvitationConfiguration {
  const raw = environment['INVITATION_TTL_SECONDS']?.trim();
  const ttlSeconds = raw ? Number(raw) : DEFAULT_INVITATION_TTL_SECONDS;
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 60 * 60 ||
    ttlSeconds > MAX_INVITATION_TTL_SECONDS
  ) {
    throw new Error('INVITATION_TTL_SECONDS must be between 3600 and 604800 seconds');
  }
  return Object.freeze({ ttlSeconds });
}
