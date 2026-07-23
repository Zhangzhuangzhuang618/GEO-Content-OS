export type ReviewDecisionErrorCode =
  | 'REVIEW_DECISION_INPUT_INVALID'
  | 'REVIEW_DECISION_NOT_FOUND'
  | 'REVIEW_DECISION_PERMISSION_DENIED'
  | 'REVIEW_DECISION_STATE_INVALID'
  | 'REVIEW_DECISION_VERSION_CONFLICT';

export class ReviewDecisionError extends Error {
  public constructor(
    public readonly code: ReviewDecisionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewDecisionError';
  }
}
