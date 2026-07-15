export type SubmitReviewErrorCode =
  | 'REVIEW_INPUT_INVALID'
  | 'REVIEW_SCOPE_NOT_FOUND'
  | 'REVIEW_STATE_INVALID'
  | 'REVIEW_VERSION_CONFLICT';

export class SubmitReviewError extends Error {
  public constructor(
    public readonly code: SubmitReviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SubmitReviewError';
  }
}
