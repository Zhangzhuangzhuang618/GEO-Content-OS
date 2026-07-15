export type ToutiaoDeliveryErrorCode =
  | 'CAPABILITY_UNAVAILABLE'
  | 'PAYLOAD_HASH_MISMATCH'
  | 'PUBLISH_REJECTED'
  | 'PUBLISH_STATE_UNKNOWN'
  | 'REMOTE_RESPONSE_INVALID';

export class ToutiaoDeliveryError extends Error {
  public constructor(
    public readonly code: ToutiaoDeliveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ToutiaoDeliveryError';
  }
}
