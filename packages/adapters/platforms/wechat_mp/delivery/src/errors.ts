export type WechatMpDeliveryErrorCode =
  | 'CAPABILITY_UNAVAILABLE'
  | 'PAYLOAD_HASH_MISMATCH'
  | 'PUBLISH_REJECTED'
  | 'PUBLISH_STATE_UNKNOWN'
  | 'REMOTE_RESPONSE_INVALID';

export class WechatMpDeliveryError extends Error {
  public constructor(
    public readonly code: WechatMpDeliveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WechatMpDeliveryError';
  }
}
