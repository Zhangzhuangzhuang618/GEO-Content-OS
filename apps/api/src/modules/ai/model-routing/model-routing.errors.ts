export type ModelRoutingErrorCode =
  | 'BUDGET_EXCEEDED'
  | 'MODEL_ROUTE_NOT_FOUND'
  | 'RATE_CARD_CONFLICT'
  | 'RATE_CARD_NOT_FOUND'
  | 'RESERVATION_CONFLICT'
  | 'RESERVATION_NOT_FOUND'
  | 'RESERVATION_STATE_INVALID'
  | 'USAGE_INVALID';

export class ModelRoutingError extends Error {
  public constructor(
    public readonly code: ModelRoutingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelRoutingError';
  }
}
