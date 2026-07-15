export type PublisherErrorCode =
  | 'PUBLISHER_AUTH_INVALID'
  | 'PUBLISHER_BUSY'
  | 'PUBLISHER_EVENT_INVALID'
  | 'PUBLISHER_LEASE_LOST'
  | 'PUBLISHER_RENDER_BLOCKED'
  | 'PUBLISHER_SCOPE_INVALID'
  | 'PUBLISHER_STATE_INVALID'
  | 'PUBLISHER_STORAGE_FAILED';

export class PublisherError extends Error {
  public constructor(
    public readonly code: PublisherErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'PublisherError';
  }
}

export interface DeliveryFailure extends Error {
  readonly code?: string;
}

export function asDeliveryFailure(error: unknown): DeliveryFailure {
  if (error instanceof Error) return error;
  return new PublisherError('PUBLISHER_STATE_INVALID', 'Platform delivery failed');
}
