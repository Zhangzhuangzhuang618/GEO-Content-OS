import type { SohuPayload } from '../../render/src/types.js';

export const SOHU_DELIVERY_VERSION = 'sohu-delivery@1.1.0' as const;
export const SOHU_EXPORT_SCHEMA_VERSION = 'sohu-export@1' as const;

export interface SohuCapabilities {
  readonly export: true;
  readonly get_status: boolean;
  readonly metrics: boolean;
  readonly publish: boolean;
  readonly version: typeof SOHU_DELIVERY_VERSION;
  readonly warnings: readonly ('CAPABILITY_PROBE_FAILED' | 'EXPORT_ONLY')[];
}

export interface SohuDeliveryInput {
  readonly content_version_id: string;
  readonly idempotency_key: string;
  readonly payload: SohuPayload;
  readonly payload_hash: string;
}

export interface SohuPublishResult {
  readonly external_id: string;
  readonly status: 'processing' | 'published';
  readonly url: string | null;
}

export interface SohuStatusResult {
  readonly external_id: string;
  readonly status: 'failed' | 'processing' | 'published' | 'unknown';
  readonly url: string | null;
}

export interface SohuMetricsResult {
  readonly external_id: string;
  readonly measured_at: string;
  readonly metrics: Readonly<Record<string, number>>;
}

export interface SohuExportFile {
  readonly body: string;
  readonly content_type: string;
  readonly path: string;
  readonly sha256: string;
}

export interface SohuExportBundle {
  readonly content_version_id: string;
  readonly files: readonly SohuExportFile[];
  readonly payload_hash: string;
  readonly platform_code: 'sohu';
  readonly schema_version: typeof SOHU_EXPORT_SCHEMA_VERSION;
}

export type SohuDeliveryResult =
  | { readonly mode: 'api'; readonly publish: SohuPublishResult }
  | { readonly export: SohuExportBundle; readonly mode: 'export' };

export interface SohuHttpRequest {
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: 'GET' | 'POST';
  readonly signal?: AbortSignal;
  readonly url: string;
}

export interface SohuHttpResponse {
  readonly body: unknown;
  readonly status_code: number;
}

export interface SohuHttpTransport {
  request(input: SohuHttpRequest): Promise<SohuHttpResponse>;
}
