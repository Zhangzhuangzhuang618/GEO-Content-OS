export type FactCheckErrorCode =
  | 'FACT_CHECK_INPUT_INVALID'
  | 'FACT_CHECK_IDEMPOTENCY_CONFLICT'
  | 'FACT_CHECK_JUDGEMENT_INVALID'
  | 'FACT_CHECK_SCOPE_NOT_FOUND';

export class FactCheckError extends Error {
  public constructor(
    public readonly code: FactCheckErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FactCheckError';
  }
}
