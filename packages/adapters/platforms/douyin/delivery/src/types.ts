import type { DouyinPayload } from '../../render/src/types.js';

export const DOUYIN_DELIVERY_VERSION = 'douyin-delivery@1.0.0' as const;
export const DOUYIN_EXPORT_SCHEMA_VERSION = 'douyin-export@1' as const;

export interface DouyinCapabilities {
  readonly export: true;
  readonly get_status: boolean;
  readonly metrics: boolean;
  readonly publish: boolean;
  readonly version: typeof DOUYIN_DELIVERY_VERSION;
  readonly warnings: readonly ('CAPABILITY_PROBE_FAILED' | 'EXPORT_ONLY')[];
}
export interface DouyinDeliveryInput {
  readonly content_version_id: string;
  readonly idempotency_key: string;
  readonly payload: DouyinPayload;
  readonly payload_hash: string;
}
export interface DouyinPublishResult {
  readonly external_id: string;
  readonly status: 'processing' | 'published';
  readonly url: string | null;
}
export interface DouyinStatusResult {
  readonly external_id: string;
  readonly status: 'failed' | 'processing' | 'published' | 'unknown';
  readonly url: string | null;
}
export interface DouyinMetricsResult {
  readonly external_id: string;
  readonly measured_at: string;
  readonly metrics: Readonly<Record<string, number>>;
}
export interface DouyinExportFile {
  readonly body: string;
  readonly content_type: string;
  readonly path: string;
  readonly sha256: string;
}
export interface DouyinExportBundle {
  readonly content_version_id: string;
  readonly files: readonly DouyinExportFile[];
  readonly payload_hash: string;
  readonly platform_code: 'douyin';
  readonly schema_version: typeof DOUYIN_EXPORT_SCHEMA_VERSION;
}
export type DouyinDeliveryResult =
  | { readonly mode: 'api'; readonly publish: DouyinPublishResult }
  | { readonly export: DouyinExportBundle; readonly mode: 'export' };
export interface DouyinHttpRequest {
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: 'GET' | 'POST';
  readonly signal?: AbortSignal;
  readonly url: string;
}
export interface DouyinHttpResponse {
  readonly body: unknown;
  readonly status_code: number;
}
export interface DouyinHttpTransport {
  request(input: DouyinHttpRequest): Promise<DouyinHttpResponse>;
}
