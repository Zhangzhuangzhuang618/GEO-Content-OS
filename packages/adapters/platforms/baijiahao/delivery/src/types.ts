import type { BaijiahaoPayload } from '../../render/src/types.js';

export const BAIJIAHAO_DELIVERY_VERSION = 'baijiahao-delivery@1.0.0' as const;
export const BAIJIAHAO_EXPORT_SCHEMA_VERSION = 'baijiahao-export@1' as const;

export interface BaijiahaoCapabilities {
  readonly export: true;
  readonly get_status: boolean;
  readonly metrics: boolean;
  readonly publish: boolean;
  readonly version: typeof BAIJIAHAO_DELIVERY_VERSION;
  readonly warnings: readonly ('CAPABILITY_PROBE_FAILED' | 'EXPORT_ONLY')[];
}

export interface BaijiahaoDeliveryInput {
  readonly content_version_id: string;
  readonly idempotency_key: string;
  readonly payload: BaijiahaoPayload;
  readonly payload_hash: string;
}

export interface BaijiahaoPublishResult {
  readonly external_id: string;
  readonly status: 'processing' | 'published';
  readonly url: string | null;
}

export interface BaijiahaoStatusResult {
  readonly external_id: string;
  readonly status: 'failed' | 'processing' | 'published' | 'unknown';
  readonly url: string | null;
}

export interface BaijiahaoMetricsResult {
  readonly external_id: string;
  readonly measured_at: string;
  readonly metrics: Readonly<Record<string, number>>;
}

export interface BaijiahaoExportFile {
  readonly body: string;
  readonly content_type: string;
  readonly path: string;
  readonly sha256: string;
}

export interface BaijiahaoExportBundle {
  readonly content_version_id: string;
  readonly files: readonly BaijiahaoExportFile[];
  readonly payload_hash: string;
  readonly platform_code: 'baijiahao';
  readonly schema_version: typeof BAIJIAHAO_EXPORT_SCHEMA_VERSION;
}

export type BaijiahaoDeliveryResult =
  | { readonly mode: 'api'; readonly publish: BaijiahaoPublishResult }
  | { readonly export: BaijiahaoExportBundle; readonly mode: 'export' };

export interface BaijiahaoHttpRequest {
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: 'GET' | 'POST';
  readonly signal?: AbortSignal;
  readonly url: string;
}

export interface BaijiahaoHttpResponse {
  readonly body: unknown;
  readonly status_code: number;
}

export interface BaijiahaoHttpTransport {
  request(input: BaijiahaoHttpRequest): Promise<BaijiahaoHttpResponse>;
}
