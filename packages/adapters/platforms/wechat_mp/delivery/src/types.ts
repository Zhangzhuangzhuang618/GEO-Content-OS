import type { WechatMpPayload } from '../../render/src/types.js';

export const WECHAT_MP_DELIVERY_VERSION = 'wechat-mp-delivery@1.0.0' as const;
export const WECHAT_MP_EXPORT_SCHEMA_VERSION = 'wechat-mp-export@1' as const;

export interface WechatMpCapabilities {
  readonly export: true;
  readonly get_status: boolean;
  readonly metrics: boolean;
  readonly publish: boolean;
  readonly version: typeof WECHAT_MP_DELIVERY_VERSION;
  readonly warnings: readonly ('CAPABILITY_PROBE_FAILED' | 'EXPORT_ONLY')[];
}

export interface WechatMpDeliveryInput {
  readonly content_version_id: string;
  readonly idempotency_key: string;
  readonly payload: WechatMpPayload;
  readonly payload_hash: string;
}

export interface WechatMpPublishResult {
  readonly external_id: string;
  readonly status: 'processing' | 'published';
  readonly url: string | null;
}
export interface WechatMpStatusResult {
  readonly external_id: string;
  readonly status: 'failed' | 'processing' | 'published' | 'unknown';
  readonly url: string | null;
}
export interface WechatMpMetricsResult {
  readonly external_id: string;
  readonly measured_at: string;
  readonly metrics: Readonly<Record<string, number>>;
}
export interface WechatMpExportFile {
  readonly body: string;
  readonly content_type: string;
  readonly path: string;
  readonly sha256: string;
}
export interface WechatMpExportBundle {
  readonly content_version_id: string;
  readonly files: readonly WechatMpExportFile[];
  readonly payload_hash: string;
  readonly platform_code: 'wechat_mp';
  readonly schema_version: typeof WECHAT_MP_EXPORT_SCHEMA_VERSION;
}
export type WechatMpDeliveryResult =
  | { readonly mode: 'api'; readonly publish: WechatMpPublishResult }
  | { readonly export: WechatMpExportBundle; readonly mode: 'export' };
export interface WechatMpHttpRequest {
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: 'GET' | 'POST';
  readonly signal?: AbortSignal;
  readonly url: string;
}
export interface WechatMpHttpResponse {
  readonly body: unknown;
  readonly status_code: number;
}
export interface WechatMpHttpTransport {
  request(input: WechatMpHttpRequest): Promise<WechatMpHttpResponse>;
}
