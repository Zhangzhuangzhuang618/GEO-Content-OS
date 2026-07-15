export type OfficialSiteDeliveryErrorCode =
  | 'CAPABILITY_UNAVAILABLE'
  | 'PAYLOAD_HASH_MISMATCH'
  | 'PUBLISH_REJECTED'
  | 'PUBLISH_STATE_UNKNOWN'
  | 'REMOTE_RESPONSE_INVALID';

export class OfficialSiteDeliveryError extends Error {
  public constructor(
    public readonly code: OfficialSiteDeliveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OfficialSiteDeliveryError';
  }
}
