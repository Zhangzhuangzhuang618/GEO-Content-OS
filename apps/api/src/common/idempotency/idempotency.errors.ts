import { ERROR_DEFINITIONS } from '@geo-content-os/contracts';

export class IdempotencyConflictError extends Error {
  public readonly code = 'IDEMPOTENCY_CONFLICT' as const;
  public readonly httpStatus = ERROR_DEFINITIONS.IDEMPOTENCY_CONFLICT.httpStatus;

  public constructor(
    public readonly scopeKey: string,
    public readonly idempotencyKey: string,
  ) {
    super(ERROR_DEFINITIONS.IDEMPOTENCY_CONFLICT.message);
    this.name = 'IdempotencyConflictError';
  }
}

export class IdempotencyProcessingError extends Error {
  public readonly httpStatus = 409;

  public constructor() {
    super('The original request is still processing; retry with the same Idempotency-Key');
    this.name = 'IdempotencyProcessingError';
  }
}
