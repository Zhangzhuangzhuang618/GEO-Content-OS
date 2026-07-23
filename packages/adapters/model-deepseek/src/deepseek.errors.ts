export type DeepSeekAdapterErrorCode =
  | 'DEEPSEEK_AUTH_FAILED'
  | 'DEEPSEEK_CANCELLED'
  | 'DEEPSEEK_CAPABILITY_UNAVAILABLE'
  | 'DEEPSEEK_INVALID_REQUEST'
  | 'DEEPSEEK_PROVIDER_FAILED'
  | 'DEEPSEEK_RATE_LIMITED'
  | 'DEEPSEEK_RESPONSE_INVALID'
  | 'DEEPSEEK_TIMEOUT';

export class DeepSeekAdapterError extends Error {
  public constructor(
    public readonly code: DeepSeekAdapterErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly httpStatus: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DeepSeekAdapterError';
  }
}
