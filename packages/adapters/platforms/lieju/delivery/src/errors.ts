export type LiejuDeliveryErrorCode =
  | 'CAPABILITY_UNAVAILABLE'
  | 'MANUAL_REQUIRED'
  | 'PAYLOAD_HASH_MISMATCH'
  | 'PUBLISH_REJECTED'
  | 'PUBLISH_STATE_UNKNOWN'
  | 'REMOTE_RESPONSE_INVALID';

export class LiejuDeliveryError extends Error {
  public constructor(
    public readonly code: LiejuDeliveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LiejuDeliveryError';
  }
}
