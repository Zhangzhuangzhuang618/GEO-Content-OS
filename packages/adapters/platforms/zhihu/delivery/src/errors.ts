export type ZhihuDeliveryErrorCode =
  | 'CAPABILITY_UNAVAILABLE'
  | 'PAYLOAD_HASH_MISMATCH'
  | 'PUBLISH_REJECTED'
  | 'PUBLISH_STATE_UNKNOWN'
  | 'REMOTE_RESPONSE_INVALID';

export class ZhihuDeliveryError extends Error {
  public constructor(
    public readonly code: ZhihuDeliveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ZhihuDeliveryError';
  }
}
