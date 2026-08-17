import { createHash } from 'node:crypto';

import { encode } from 'iconv-lite';

import type { LiejuDeliveryConfig } from './config.js';
import { LiejuDeliveryError, type LiejuOfficialResponseDiagnostics } from './errors.js';
import type { LiejuDeliveryInput, LiejuPublishResult } from './types.js';

type OfficialConfig = Extract<LiejuDeliveryConfig, { readonly delivery_method: 'official_api' }>;

export interface LiejuOfficialApiRequest {
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface LiejuOfficialApiResponseContext {
  readonly bodyBytes?: number;
  readonly contentType?: string | null;
  readonly statusCode?: number;
}

export function buildLiejuOfficialApiRequest(
  configuration: OfficialConfig,
  input: LiejuDeliveryInput,
): LiejuOfficialApiRequest {
  const boundary = `----geo-content-os-${sha256(input.idempotency_key).slice(0, 24)}`;
  const imageMarkup = (input.image_urls ?? []).map((url) => `[img]${url}[/img]`).join('\r\n');
  const content = imageMarkup
    ? `${input.payload.body_text}\r\n\r\n${imageMarkup}`
    : input.payload.body_text;
  const fields = Object.freeze([
    ['api', '1'],
    ['api_key', configuration.api_key],
    ['postdb[fid]', configuration.fid],
    ['postdb[leibie]', configuration.posting_profile.category_id],
    ['postdb[city_id]', configuration.city_id],
    ['postdb[zone_id]', configuration.posting_profile.zone_id],
    ['postdb[title]', input.payload.title],
    ['postdb[dizhi]', configuration.posting_profile.address],
    ['postdb[content]', content],
    ['postdb[mobphone]', configuration.posting_profile.mobile_phone],
    ['postdb[oicq]', configuration.posting_profile.qq],
    ['postdb[wechat]', configuration.posting_profile.wechat],
    ['postdb[linkman]', configuration.posting_profile.contact_name],
  ] as const);
  const chunks: Buffer[] = [];
  for (const [name, value] of fields) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`,
        'ascii',
      ),
      encode(value, 'gbk'),
      Buffer.from('\r\n', 'ascii'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'ascii'));
  return Object.freeze({
    body: new Uint8Array(Buffer.concat(chunks)),
    contentType: `multipart/form-data; boundary=${boundary}`,
  });
}

export function parseLiejuOfficialApiResponse(
  value: unknown,
  idempotencyKey: string,
  context: LiejuOfficialApiResponseContext = {},
): LiejuPublishResult {
  const normalized = responseText(value);
  const diagnostics = diagnoseLiejuOfficialApiResponse(value, context);
  if (REJECTION.test(normalized)) {
    throw new LiejuDeliveryError('PUBLISH_REJECTED', 'Lieju official API rejected publication');
  }
  if (!explicitSuccess(value, normalized)) {
    throw new LiejuDeliveryError(
      'PUBLISH_STATE_UNKNOWN',
      'Lieju official API returned an unrecognized publication response',
      diagnostics,
    );
  }
  const url = findPublicUrl(value, normalized);
  return Object.freeze({
    external_id: findRemoteReference(value, url) ?? `api-${sha256(idempotencyKey).slice(0, 32)}`,
    response_hash: diagnostics.response_sha256,
    status: 'processing',
    url,
  });
}

export function diagnoseLiejuOfficialApiResponse(
  value: unknown,
  context: LiejuOfficialApiResponseContext = {},
): LiejuOfficialResponseDiagnostics {
  const normalized = responseText(value);
  const signals: Array<'captcha_required' | 'login_required' | 'redirect'> = [];
  if (/(?:验证码|captcha)/iu.test(normalized)) signals.push('captcha_required');
  if (/(?:请登录|会员登录|\blog[ -]?in\b|\bsign[ -]?in\b)/iu.test(normalized)) {
    signals.push('login_required');
  }
  if (/(?:location(?:\.href)?\s*=|http-equiv\s*=\s*["']?refresh)/iu.test(normalized)) {
    signals.push('redirect');
  }
  const recognizedFields = record(value)
    ? OFFICIAL_RESPONSE_FIELDS.filter((field) => Object.hasOwn(value, field))
    : [];
  return Object.freeze({
    body_bytes: safeBodyBytes(context.bodyBytes, normalized),
    content_type: safeContentType(context.contentType),
    http_status: safeHttpStatus(context.statusCode),
    ...(recognizedFields.length > 0 ? { recognized_fields: Object.freeze(recognizedFields) } : {}),
    response_kind: responseKind(value, normalized),
    response_sha256: sha256(normalized),
    schema_version: 'lieju-official-response-diagnostics@1',
    signals: Object.freeze(signals),
  });
}

const REJECTION =
  /(?:发布失败|提交失败|错误|无效|过期|未授权|禁止|余额不足|次数不足|验证码|api[_ ]?key[^\n]{0,20}(?:错误|无效))/iu;
const SUCCESS = /(?:发布成功|提交成功|信息发布成功)/u;
const OFFICIAL_RESPONSE_FIELDS = Object.freeze([
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
] as const);

function explicitSuccess(value: unknown, normalized: string): boolean {
  if (SUCCESS.test(normalized)) return true;
  if (!record(value)) return false;
  const code = value['code'];
  return (
    value['success'] === true ||
    ['ok', 'success'].includes(String(value['status'] ?? '').toLowerCase()) ||
    code === 0 ||
    code === 200 ||
    code === '0' ||
    code === '200'
  );
}

function findPublicUrl(value: unknown, normalized: string): string | null {
  const values = strings(value);
  values.push(...(normalized.match(/https:\/\/[^\s"'<>,，]+/giu) ?? []));
  for (const candidate of values) {
    try {
      const url = new URL(candidate.replace(/[),，。]+$/u, ''));
      if (
        url.protocol === 'https:' &&
        (url.hostname === 'lieju.com' || url.hostname.endsWith('.lieju.com'))
      ) {
        return url.toString();
      }
    } catch {
      continue;
    }
  }
  return null;
}

function findRemoteReference(value: unknown, url: string | null): string | null {
  if (record(value)) {
    for (const key of ['external_id', 'post_id', 'info_id', 'id']) {
      const candidate = value[key];
      if (typeof candidate === 'string' || typeof candidate === 'number') {
        const normalized = String(candidate).trim();
        if (/^[A-Za-z0-9._:-]{1,240}$/u.test(normalized)) return normalized;
      }
    }
    if (record(value['data'])) return findRemoteReference(value['data'], url);
  }
  return url ? (/\/(\d+)\.html(?:$|\?)/u.exec(url)?.[1] ?? null) : null;
}

function responseText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  try {
    return JSON.stringify(value) || '';
  } catch {
    return '';
  }
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (record(value)) return Object.values(value).flatMap(strings);
  return [];
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseKind(
  value: unknown,
  normalized: string,
): LiejuOfficialResponseDiagnostics['response_kind'] {
  if (normalized.length === 0) return 'empty';
  if (Array.isArray(value) || record(value)) return 'json';
  return /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b|<script\b)/iu.test(normalized)
    ? 'html'
    : 'text';
}

function safeBodyBytes(value: number | undefined, normalized: string): number {
  return Number.isSafeInteger(value) && value !== undefined && value >= 0
    ? value
    : Buffer.byteLength(normalized, 'utf8');
}

function safeContentType(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const mime = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mime) ? mime.slice(0, 120) : null;
}

function safeHttpStatus(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value >= 100 && value <= 599
    ? value
    : 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
