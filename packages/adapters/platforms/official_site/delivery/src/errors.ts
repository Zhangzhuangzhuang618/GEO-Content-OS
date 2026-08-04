export type OfficialSiteDeliveryErrorCode =
  | 'CAPABILITY_UNAVAILABLE'
  | 'MEDIA_UPLOAD_REJECTED'
  | 'MEDIA_UPLOAD_STATE_UNKNOWN'
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
