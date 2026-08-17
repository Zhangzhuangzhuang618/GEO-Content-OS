export type LiejuDeliveryErrorCode =
  | 'CAPABILITY_UNAVAILABLE'
  | 'MANUAL_REQUIRED'
  | 'PAYLOAD_HASH_MISMATCH'
  | 'PUBLISH_REJECTED'
  | 'PUBLISH_STATE_UNKNOWN'
  | 'REMOTE_RESPONSE_INVALID';

export interface LiejuOfficialResponseDiagnostics {
  readonly body_bytes: number;
  readonly content_type: string | null;
  readonly http_status: number;
  readonly recognized_fields?: readonly string[];
  readonly response_kind: 'empty' | 'html' | 'json' | 'text';
  readonly response_sha256: string;
  readonly schema_version: 'lieju-official-response-diagnostics@1';
  readonly signals: readonly ('captcha_required' | 'login_required' | 'redirect')[];
}

export class LiejuDeliveryError extends Error {
  public constructor(
    public readonly code: LiejuDeliveryErrorCode,
    message: string,
    public readonly diagnostics?: LiejuOfficialResponseDiagnostics,
  ) {
    super(message);
    this.name = 'LiejuDeliveryError';
  }
}
