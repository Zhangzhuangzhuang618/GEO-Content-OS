import type { ZhihuPayload } from '../../render/src/types.js';

export const ZHIHU_DELIVERY_VERSION = 'zhihu-delivery@1.0.0' as const;
export const ZHIHU_EXPORT_SCHEMA_VERSION = 'zhihu-export@1' as const;

export interface ZhihuCapabilities {
  readonly export: true;
  readonly get_status: boolean;
  readonly metrics: boolean;
  readonly publish: boolean;
  readonly version: typeof ZHIHU_DELIVERY_VERSION;
  readonly warnings: readonly ('CAPABILITY_PROBE_FAILED' | 'EXPORT_ONLY')[];
}

export interface ZhihuDeliveryInput {
  readonly content_version_id: string;
  readonly idempotency_key: string;
  readonly payload: ZhihuPayload;
  readonly payload_hash: string;
}

export interface ZhihuPublishResult {
  readonly external_id: string;
  readonly status: 'processing' | 'published';
  readonly url: string | null;
}

export interface ZhihuStatusResult {
  readonly external_id: string;
  readonly status: 'failed' | 'processing' | 'published' | 'unknown';
  readonly url: string | null;
}

export interface ZhihuMetricsResult {
  readonly external_id: string;
  readonly measured_at: string;
  readonly metrics: Readonly<Record<string, number>>;
}

export interface ZhihuExportFile {
  readonly body: string;
  readonly content_type: string;
  readonly path: string;
  readonly sha256: string;
}

export interface ZhihuExportBundle {
  readonly content_version_id: string;
  readonly files: readonly ZhihuExportFile[];
  readonly payload_hash: string;
  readonly platform_code: 'zhihu';
  readonly schema_version: typeof ZHIHU_EXPORT_SCHEMA_VERSION;
}

export type ZhihuDeliveryResult =
  | { readonly mode: 'api'; readonly publish: ZhihuPublishResult }
  | { readonly export: ZhihuExportBundle; readonly mode: 'export' };

export interface ZhihuHttpRequest {
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: 'GET' | 'POST';
  readonly signal?: AbortSignal;
  readonly url: string;
}

export interface ZhihuHttpResponse {
  readonly body: unknown;
  readonly status_code: number;
}

export interface ZhihuHttpTransport {
  request(input: ZhihuHttpRequest): Promise<ZhihuHttpResponse>;
}
