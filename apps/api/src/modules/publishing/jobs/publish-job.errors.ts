export type PublishJobErrorCode =
  | 'PUBLISH_ACCOUNT_AUTH_EXPIRED'
  | 'PUBLISH_CAPABILITY_UNAVAILABLE'
  | 'PUBLISH_JOB_INPUT_INVALID'
  | 'PUBLISH_JOB_NOT_FOUND'
  | 'PUBLISH_JOB_STATE_INVALID'
  | 'PUBLISH_JOB_VERSION_CONFLICT';

export class PublishJobError extends Error {
  public constructor(
    public readonly code: PublishJobErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PublishJobError';
  }
}
