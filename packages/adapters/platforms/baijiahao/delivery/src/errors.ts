export type BaijiahaoDeliveryErrorCode =
  | 'CAPABILITY_UNAVAILABLE'
  | 'PAYLOAD_HASH_MISMATCH'
  | 'PUBLISH_REJECTED'
  | 'PUBLISH_STATE_UNKNOWN'
  | 'REMOTE_RESPONSE_INVALID';

export class BaijiahaoDeliveryError extends Error {
  public constructor(
    public readonly code: BaijiahaoDeliveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BaijiahaoDeliveryError';
  }
}
