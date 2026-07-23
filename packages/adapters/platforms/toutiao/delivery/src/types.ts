import type { ToutiaoPayload } from '../../render/src/types.js';

export const TOUTIAO_DELIVERY_VERSION = 'toutiao-delivery@1.0.0' as const;
export const TOUTIAO_EXPORT_SCHEMA_VERSION = 'toutiao-export@1' as const;

export interface ToutiaoCapabilities {
  readonly export: true;
  readonly get_status: boolean;
  readonly metrics: boolean;
  readonly publish: boolean;
  readonly version: typeof TOUTIAO_DELIVERY_VERSION;
  readonly warnings: readonly ('CAPABILITY_PROBE_FAILED' | 'EXPORT_ONLY')[];
}

export interface ToutiaoDeliveryInput {
  readonly content_version_id: string;
  readonly idempotency_key: string;
  readonly payload: ToutiaoPayload;
  readonly payload_hash: string;
}

export interface ToutiaoPublishResult {
  readonly external_id: string;
  readonly status: 'processing' | 'published';
  readonly url: string | null;
}

export interface ToutiaoStatusResult {
  readonly external_id: string;
  readonly status: 'failed' | 'processing' | 'published' | 'unknown';
  readonly url: string | null;
}

export interface ToutiaoMetricsResult {
  readonly external_id: string;
  readonly measured_at: string;
  readonly metrics: Readonly<Record<string, number>>;
}

export interface ToutiaoExportFile {
  readonly body: string;
  readonly content_type: string;
  readonly path: string;
  readonly sha256: string;
}

export interface ToutiaoExportBundle {
  readonly content_version_id: string;
  readonly files: readonly ToutiaoExportFile[];
  readonly payload_hash: string;
  readonly platform_code: 'toutiao';
  readonly schema_version: typeof TOUTIAO_EXPORT_SCHEMA_VERSION;
}

export type ToutiaoDeliveryResult =
  | { readonly mode: 'api'; readonly publish: ToutiaoPublishResult }
  | { readonly export: ToutiaoExportBundle; readonly mode: 'export' };

export interface ToutiaoHttpRequest {
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: 'GET' | 'POST';
  readonly signal?: AbortSignal;
  readonly url: string;
}

export interface ToutiaoHttpResponse {
  readonly body: unknown;
  readonly status_code: number;
}

export interface ToutiaoHttpTransport {
  request(input: ToutiaoHttpRequest): Promise<ToutiaoHttpResponse>;
}
