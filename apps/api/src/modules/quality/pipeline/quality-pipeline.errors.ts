export type QualityPipelineErrorCode =
  | 'QUALITY_INPUT_INVALID'
  | 'QUALITY_EVALUATION_INVALID'
  | 'QUALITY_IDEMPOTENCY_CONFLICT'
  | 'QUALITY_SCOPE_NOT_FOUND'
  | 'QUALITY_STATE_INVALID'
  | 'QUALITY_VERSION_CONFLICT';

export class QualityPipelineError extends Error {
  public constructor(
    public readonly code: QualityPipelineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'QualityPipelineError';
  }
}
