export class PublishingApiError extends Error {
  public constructor(
    public readonly code:
      'PUBLISHING_ARTIFACT_UNAVAILABLE' | 'PUBLISHING_INPUT_INVALID' | 'PUBLISHING_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'PublishingApiError';
  }
}
