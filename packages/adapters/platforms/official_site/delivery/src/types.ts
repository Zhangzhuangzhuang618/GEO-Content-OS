import type { OfficialSitePayload } from '../../render/src/types.js';

export const OFFICIAL_SITE_DELIVERY_VERSION = 'official-site-delivery@1.1.0' as const;
export const OFFICIAL_SITE_EXPORT_SCHEMA_VERSION = 'official-site-export@1' as const;
export const ZHIYUAN_NEWS_PAYLOAD_SCHEMA_VERSION = 'zhiyuan-news-payload@1' as const;

export interface OfficialSiteCapabilities {
  readonly export: true;
  readonly get_status: boolean;
  readonly media_upload: boolean;
  readonly metrics: boolean;
  readonly publish: boolean;
  readonly version: typeof OFFICIAL_SITE_DELIVERY_VERSION;
  readonly warnings: readonly ('CAPABILITY_PROBE_FAILED' | 'EXPORT_ONLY')[];
}

export interface OfficialSiteMediaUploadInput {
  readonly asset_id: string;
  readonly body: Uint8Array;
  readonly content_hash: string;
  readonly content_type: 'image/jpeg';
  readonly content_version_id: string;
  readonly idempotency_key: string;
  readonly role: 'body' | 'cover';
}

export interface OfficialSiteMediaUploadResult {
  readonly asset_id: string;
  readonly content_hash: string;
  readonly content_type: 'image/jpeg';
  readonly size_bytes: number;
  readonly url: string;
}

export interface OfficialSiteDeliveryInput {
  readonly content_version_id: string;
  readonly idempotency_key: string;
  readonly payload: OfficialSitePayload;
  readonly payload_hash: string;
}

export interface OfficialSiteApiPayload {
  readonly body_html: string;
  readonly meta_description: string;
  readonly platform_code: 'official_site';
  readonly schema_version: typeof ZHIYUAN_NEWS_PAYLOAD_SCHEMA_VERSION;
  readonly seo_keywords: readonly string[];
  readonly summary: string;
  readonly title: string;
}

export interface OfficialSitePublishResult {
  readonly external_id: string;
  readonly published_at: string;
  readonly status: 'processing' | 'published';
  readonly url: string | null;
}

export interface OfficialSiteStatusResult {
  readonly external_id: string;
  readonly published_at: string;
  readonly status: 'failed' | 'processing' | 'published' | 'unknown';
  readonly url: string | null;
}

export interface OfficialSiteMetricsResult {
  readonly external_id: string;
  readonly measured_at: string;
  readonly metrics: Readonly<Record<string, number>>;
}

export interface OfficialSiteExportFile {
  readonly body: string;
  readonly content_type: string;
  readonly path: string;
  readonly sha256: string;
}

export interface OfficialSiteExportBundle {
  readonly files: readonly OfficialSiteExportFile[];
  readonly payload_hash: string;
  readonly platform_code: 'official_site';
  readonly schema_version: typeof OFFICIAL_SITE_EXPORT_SCHEMA_VERSION;
  readonly slug: string;
}

export type OfficialSiteDeliveryResult =
  | { readonly mode: 'api'; readonly publish: OfficialSitePublishResult }
  | { readonly export: OfficialSiteExportBundle; readonly mode: 'export' };

export interface OfficialSiteHttpRequest {
  readonly body?: Uint8Array | unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: 'GET' | 'POST';
  readonly signal?: AbortSignal;
  readonly url: string;
}

export interface OfficialSiteHttpResponse {
  readonly body: unknown;
  readonly status_code: number;
}

export interface OfficialSiteHttpTransport {
  request(input: OfficialSiteHttpRequest): Promise<OfficialSiteHttpResponse>;
}
