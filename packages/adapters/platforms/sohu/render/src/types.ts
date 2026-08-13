import type { ContentWriterContent } from '@geo-content-os/contracts/skills';

export const SOHU_PLATFORM_CODE = 'sohu' as const;
export const SOHU_RENDER_RULE_VERSION = 'sohu-render-rules@1.0.0' as const;
export const SOHU_PAYLOAD_SCHEMA_VERSION = 'sohu-payload@1' as const;

export interface SohuPlatformMeta {
  readonly abstract: string;
  readonly body_asset_ids?: readonly string[];
  readonly content_type: string;
  readonly cover_asset_id?: string | null;
}

export interface SohuCitationLink {
  readonly citation_id: string;
  readonly label: string;
  readonly url: string;
}

export interface SohuContent extends Omit<ContentWriterContent, 'platform_code' | 'platform_meta'> {
  readonly platform_code: typeof SOHU_PLATFORM_CODE;
  readonly platform_meta: SohuPlatformMeta;
}

export interface SohuRenderInput {
  readonly citations: readonly SohuCitationLink[];
  readonly content: SohuContent;
  readonly rule_version: typeof SOHU_RENDER_RULE_VERSION;
}

export interface SohuPayload {
  readonly abstract: string;
  readonly ai_generated: true;
  readonly body_html: string;
  readonly body_asset_ids: readonly string[];
  readonly body_text: string;
  readonly citation_links: readonly SohuCitationLink[];
  readonly content_type: string;
  readonly cover_asset_id: string | null;
  readonly original: false;
  readonly platform_code: typeof SOHU_PLATFORM_CODE;
  readonly rule_version: typeof SOHU_RENDER_RULE_VERSION;
  readonly schema_version: typeof SOHU_PAYLOAD_SCHEMA_VERSION;
  readonly title: string;
}

export type SohuValidationCode =
  | 'ABSTRACT_LENGTH_OUT_OF_RANGE'
  | 'PAYLOAD_SCHEMA_INVALID'
  | 'SEGMENTATION_REQUIRED'
  | 'TITLE_LENGTH_OUT_OF_RANGE';

export interface SohuValidationIssue {
  readonly code: SohuValidationCode;
  readonly message: string;
  readonly path: string;
  readonly severity: 'blocker';
}

export type SohuValidationResult =
  | { readonly issues: readonly []; readonly ok: true; readonly value: SohuRenderInput }
  | { readonly issues: readonly SohuValidationIssue[]; readonly ok: false };

export type SohuRenderResult =
  | { readonly issues: readonly []; readonly ok: true; readonly payload: SohuPayload }
  | { readonly issues: readonly SohuValidationIssue[]; readonly ok: false };
