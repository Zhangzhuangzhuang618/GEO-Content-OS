export type ReviewApiErrorKind = 'not_found' | 'permission' | 'state' | 'validation' | 'version';

export class ReviewApiError extends Error {
  public constructor(
    public readonly kind: ReviewApiErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewApiError';
  }
}
