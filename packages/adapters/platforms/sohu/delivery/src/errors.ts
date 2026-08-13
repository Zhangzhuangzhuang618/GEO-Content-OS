export type SohuDeliveryErrorCode =
  | 'CAPABILITY_UNAVAILABLE'
  | 'MANUAL_REQUIRED'
  | 'PAYLOAD_HASH_MISMATCH'
  | 'PUBLISH_REJECTED'
  | 'PUBLISH_STATE_UNKNOWN'
  | 'REMOTE_RESPONSE_INVALID';

export class SohuDeliveryError extends Error {
  public constructor(
    public readonly code: SohuDeliveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SohuDeliveryError';
  }
}
