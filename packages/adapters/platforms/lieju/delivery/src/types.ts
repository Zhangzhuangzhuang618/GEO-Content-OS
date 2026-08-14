import type { LiejuPayload } from '../../render/src/types.js';

export const LIEJU_DELIVERY_VERSION = 'lieju-delivery@1.1.0' as const;
export const LIEJU_EXPORT_SCHEMA_VERSION = 'lieju-export@1' as const;

export interface LiejuCapabilities {
  readonly export: true;
  readonly get_status: boolean;
  readonly metrics: boolean;
  readonly publish: boolean;
  readonly version: typeof LIEJU_DELIVERY_VERSION;
  readonly warnings: readonly ('CAPABILITY_PROBE_FAILED' | 'EXPORT_ONLY')[];
}

export interface LiejuDeliveryInput {
  readonly content_version_id: string;
  readonly idempotency_key: string;
  readonly payload: LiejuPayload;
  readonly payload_hash: string;
}

export interface LiejuPublishResult {
  readonly external_id: string;
  readonly status: 'processing' | 'published';
  readonly url: string | null;
}

export interface LiejuStatusResult {
  readonly external_id: string;
  readonly status: 'failed' | 'processing' | 'published' | 'unknown';
  readonly url: string | null;
}

export interface LiejuMetricsResult {
  readonly external_id: string;
  readonly measured_at: string;
  readonly metrics: Readonly<Record<string, number>>;
}

export interface LiejuExportFile {
  readonly body: string;
  readonly content_type: string;
  readonly path: string;
  readonly sha256: string;
}

export interface LiejuExportBundle {
  readonly content_version_id: string;
  readonly files: readonly LiejuExportFile[];
  readonly payload_hash: string;
  readonly platform_code: 'lieju';
  readonly schema_version: typeof LIEJU_EXPORT_SCHEMA_VERSION;
}

export type LiejuDeliveryResult =
  | { readonly mode: 'api'; readonly publish: LiejuPublishResult }
  | { readonly export: LiejuExportBundle; readonly mode: 'export' };

export interface LiejuHttpRequest {
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: 'GET' | 'POST';
  readonly signal?: AbortSignal;
  readonly url: string;
}

export interface LiejuHttpResponse {
  readonly body: unknown;
  readonly status_code: number;
}

export interface LiejuHttpTransport {
  request(input: LiejuHttpRequest): Promise<LiejuHttpResponse>;
}
