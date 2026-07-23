export type DouyinDeliveryErrorCode =
  | 'CAPABILITY_UNAVAILABLE'
  | 'PAYLOAD_HASH_MISMATCH'
  | 'PUBLISH_REJECTED'
  | 'PUBLISH_STATE_UNKNOWN'
  | 'REMOTE_RESPONSE_INVALID';

export class DouyinDeliveryError extends Error {
  public constructor(
    public readonly code: DouyinDeliveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DouyinDeliveryError';
  }
}
