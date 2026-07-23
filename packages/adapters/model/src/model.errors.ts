export type ModelAdapterErrorCode =
  | 'MODEL_CANCELLED'
  | 'MODEL_CAPABILITY_UNAVAILABLE'
  | 'MODEL_INVALID_INPUT'
  | 'MODEL_RESPONSE_INVALID';

export class ModelAdapterError extends Error {
  public constructor(
    public readonly code: ModelAdapterErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ModelAdapterError';
  }
}
