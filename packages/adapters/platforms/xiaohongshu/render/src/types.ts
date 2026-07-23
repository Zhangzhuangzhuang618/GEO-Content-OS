import type { ContentWriterContent } from '@geo-content-os/contracts/skills';

export const XIAOHONGSHU_PLATFORM_CODE = 'xiaohongshu' as const;
export const XIAOHONGSHU_RENDER_RULE_VERSION = 'xiaohongshu-render-rules@1.0.0' as const;
export const XIAOHONGSHU_PAYLOAD_SCHEMA_VERSION = 'xiaohongshu-payload@1' as const;

export interface XiaohongshuPlatformMeta {
  readonly cover_text: string;
  readonly note_type: string;
  readonly topics: readonly string[];
}

export interface XiaohongshuCitationLink {
  readonly citation_id: string;
  readonly label: string;
  readonly url: string;
}

export interface XiaohongshuContent extends Omit<
  ContentWriterContent,
  'platform_code' | 'platform_meta'
> {
  readonly platform_code: typeof XIAOHONGSHU_PLATFORM_CODE;
  readonly platform_meta: XiaohongshuPlatformMeta;
}

export interface XiaohongshuRenderInput {
  readonly citations: readonly XiaohongshuCitationLink[];
  readonly content: XiaohongshuContent;
  readonly rule_version: typeof XIAOHONGSHU_RENDER_RULE_VERSION;
}

export interface XiaohongshuPayload {
  readonly body_html: string;
  readonly body_text: string;
  readonly citation_links: readonly XiaohongshuCitationLink[];
  readonly cover_text: string;
  readonly note_type: string;
  readonly platform_code: typeof XIAOHONGSHU_PLATFORM_CODE;
  readonly rule_version: typeof XIAOHONGSHU_RENDER_RULE_VERSION;
  readonly schema_version: typeof XIAOHONGSHU_PAYLOAD_SCHEMA_VERSION;
  readonly title: string;
  readonly topics: readonly string[];
}

export type XiaohongshuValidationCode =
  | 'CITATION_LINK_MISSING'
  | 'LIST_BLOCK_REQUIRED'
  | 'PARAGRAPH_TOO_LONG'
  | 'PAYLOAD_SCHEMA_INVALID'
  | 'TITLE_LENGTH_OUT_OF_RANGE'
  | 'TOPIC_REQUIRED'
  | 'UNVERIFIED_EXPERIENCE_CLAIM';

export interface XiaohongshuValidationIssue {
  readonly code: XiaohongshuValidationCode;
  readonly message: string;
  readonly path: string;
  readonly severity: 'blocker';
}

export type XiaohongshuValidationResult =
  | { readonly issues: readonly []; readonly ok: true; readonly value: XiaohongshuRenderInput }
  | { readonly issues: readonly XiaohongshuValidationIssue[]; readonly ok: false };

export type XiaohongshuRenderResult =
  | { readonly issues: readonly []; readonly ok: true; readonly payload: XiaohongshuPayload }
  | { readonly issues: readonly XiaohongshuValidationIssue[]; readonly ok: false };
