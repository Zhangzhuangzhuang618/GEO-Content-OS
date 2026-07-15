export type PlatformAccountErrorCode =
  | 'PLATFORM_ACCOUNT_NOT_FOUND'
  | 'PLATFORM_ACCOUNT_VERSION_CONFLICT'
  | 'PLATFORM_ACCOUNT_STATE_INVALID'
  | 'PLATFORM_ACCOUNT_CREDENTIAL_INVALID';
export class PlatformAccountError extends Error {
  public constructor(
    public readonly code: PlatformAccountErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PlatformAccountError';
  }
}
