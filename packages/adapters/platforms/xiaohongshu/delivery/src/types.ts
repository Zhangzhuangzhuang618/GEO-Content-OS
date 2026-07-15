import type { XiaohongshuPayload } from '../../render/src/types.js';

export const XIAOHONGSHU_DELIVERY_VERSION = 'xiaohongshu-delivery@1.0.0' as const;
export const XIAOHONGSHU_EXPORT_SCHEMA_VERSION = 'xiaohongshu-export@1' as const;

export interface XiaohongshuCapabilities {
  readonly export: true;
  readonly get_status: boolean;
  readonly metrics: boolean;
  readonly publish: boolean;
  readonly version: typeof XIAOHONGSHU_DELIVERY_VERSION;
  readonly warnings: readonly ('CAPABILITY_PROBE_FAILED' | 'EXPORT_ONLY')[];
}

export interface XiaohongshuDeliveryInput {
  readonly content_version_id: string;
  readonly idempotency_key: string;
  readonly payload: XiaohongshuPayload;
  readonly payload_hash: string;
}

export interface XiaohongshuPublishResult {
  readonly external_id: string;
  readonly status: 'processing' | 'published';
  readonly url: string | null;
}
export interface XiaohongshuStatusResult {
  readonly external_id: string;
  readonly status: 'failed' | 'processing' | 'published' | 'unknown';
  readonly url: string | null;
}
export interface XiaohongshuMetricsResult {
  readonly external_id: string;
  readonly measured_at: string;
  readonly metrics: Readonly<Record<string, number>>;
}
export interface XiaohongshuExportFile {
  readonly body: string;
  readonly content_type: string;
  readonly path: string;
  readonly sha256: string;
}
export interface XiaohongshuExportBundle {
  readonly content_version_id: string;
  readonly files: readonly XiaohongshuExportFile[];
  readonly payload_hash: string;
  readonly platform_code: 'xiaohongshu';
  readonly schema_version: typeof XIAOHONGSHU_EXPORT_SCHEMA_VERSION;
}
export type XiaohongshuDeliveryResult =
  | { readonly mode: 'api'; readonly publish: XiaohongshuPublishResult }
  | { readonly export: XiaohongshuExportBundle; readonly mode: 'export' };
export interface XiaohongshuHttpRequest {
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: 'GET' | 'POST';
  readonly signal?: AbortSignal;
  readonly url: string;
}
export interface XiaohongshuHttpResponse {
  readonly body: unknown;
  readonly status_code: number;
}
export interface XiaohongshuHttpTransport {
  request(input: XiaohongshuHttpRequest): Promise<XiaohongshuHttpResponse>;
}
