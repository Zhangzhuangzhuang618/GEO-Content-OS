export type PublisherErrorCode =
  | 'PUBLISHER_AUTH_INVALID'
  | 'PUBLISHER_BUSY'
  | 'PUBLISHER_DELIVERY_RETRY'
  | 'PUBLISHER_EVENT_INVALID'
  | 'PUBLISHER_LEASE_LOST'
  | 'PUBLISHER_RENDER_BLOCKED'
  | 'PUBLISHER_SCOPE_INVALID'
  | 'PUBLISHER_STATE_INVALID'
  | 'PUBLISHER_STORAGE_FAILED';

export class PublisherError extends Error {
  public constructor(
    public readonly code: PublisherErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'PublisherError';
  }
}

export interface DeliveryFailure extends Error {
  readonly code?: string;
  readonly diagnostics?: unknown;
}

export function asDeliveryFailure(error: unknown): DeliveryFailure {
  if (error instanceof Error) return error;
  return new PublisherError('PUBLISHER_STATE_INVALID', 'Platform delivery failed');
}

const DIAGNOSTIC_SIGNALS = new Set(['captcha_required', 'login_required', 'redirect']);
const RECOGNIZED_FIELDS = new Set([
  'code',
  'data',
  'external_id',
  'id',
  'info_id',
  'message',
  'post_id',
  'status',
  'success',
  'url',
]);

export function safeDeliveryDiagnostics(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (!record(value) || value['schema_version'] !== 'lieju-official-response-diagnostics@1') {
    return undefined;
  }
  const bodyBytes = value['body_bytes'];
  const contentType = value['content_type'];
  const httpStatus = value['http_status'];
  const responseKind = value['response_kind'];
  const responseSha256 = value['response_sha256'];
  const signals = stringList(value['signals'], DIAGNOSTIC_SIGNALS);
  if (
    !Number.isSafeInteger(bodyBytes) ||
    (bodyBytes as number) < 0 ||
    !(
      contentType === null ||
      (typeof contentType === 'string' &&
        contentType.length <= 120 &&
        /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(contentType))
    ) ||
    !Number.isSafeInteger(httpStatus) ||
    !(
      (httpStatus as number) === 0 ||
      ((httpStatus as number) >= 100 && (httpStatus as number) <= 599)
    ) ||
    !['empty', 'html', 'json', 'text'].includes(String(responseKind)) ||
    typeof responseSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(responseSha256) ||
    signals === undefined
  ) {
    return undefined;
  }
  const recognizedFields = stringList(value['recognized_fields'], RECOGNIZED_FIELDS, true);
  if (recognizedFields === undefined) return undefined;
  return Object.freeze({
    body_bytes: bodyBytes,
    content_type: contentType,
    http_status: httpStatus,
    ...(recognizedFields.length > 0 ? { recognized_fields: Object.freeze(recognizedFields) } : {}),
    response_kind: responseKind,
    response_sha256: responseSha256,
    schema_version: 'lieju-official-response-diagnostics@1',
    signals: Object.freeze(signals),
  });
}

function stringList(
  value: unknown,
  allowed: ReadonlySet<string>,
  optional = false,
): string[] | undefined {
  if (value === undefined && optional) return [];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !allowed.has(item))
  ) {
    return undefined;
  }
  return [...new Set(value as string[])];
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
