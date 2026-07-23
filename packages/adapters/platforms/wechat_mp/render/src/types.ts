import type { ContentWriterContent } from '@geo-content-os/contracts/skills';

export const WECHAT_MP_PLATFORM_CODE = 'wechat_mp' as const;
export const WECHAT_MP_RENDER_RULE_VERSION = 'wechat-mp-render-rules@1.0.0' as const;
export const WECHAT_MP_PAYLOAD_SCHEMA_VERSION = 'wechat-mp-payload@1' as const;

export interface WechatMpPlatformMeta {
  readonly author: string;
  readonly cover_asset_id: string;
  readonly digest: string;
}

export interface WechatMpCitationLink {
  readonly citation_id: string;
  readonly label: string;
  readonly url: string;
}

export interface WechatMpInternalLink {
  readonly label: string;
  readonly url: string;
}

export interface WechatMpContent extends Omit<
  ContentWriterContent,
  'platform_code' | 'platform_meta'
> {
  readonly platform_code: typeof WECHAT_MP_PLATFORM_CODE;
  readonly platform_meta: WechatMpPlatformMeta;
}

export interface WechatMpRenderInput {
  readonly citations: readonly WechatMpCitationLink[];
  readonly content: WechatMpContent;
  readonly internal_links: readonly WechatMpInternalLink[];
  readonly rule_version: typeof WECHAT_MP_RENDER_RULE_VERSION;
}

export interface WechatMpPayload {
  readonly author: string;
  readonly body_html: string;
  readonly body_text: string;
  readonly citation_links: readonly WechatMpCitationLink[];
  readonly cover_asset_id: string;
  readonly cta: string;
  readonly digest: string;
  readonly internal_links: readonly WechatMpInternalLink[];
  readonly platform_code: typeof WECHAT_MP_PLATFORM_CODE;
  readonly rule_version: typeof WECHAT_MP_RENDER_RULE_VERSION;
  readonly schema_version: typeof WECHAT_MP_PAYLOAD_SCHEMA_VERSION;
  readonly title: string;
}

export type WechatMpValidationCode =
  | 'CITATION_LINK_MISSING'
  | 'CTA_REQUIRED'
  | 'DIGEST_REQUIRED'
  | 'INTERNAL_LINK_REQUIRED'
  | 'LEAD_REQUIRED'
  | 'PARAGRAPH_TOO_LONG'
  | 'PAYLOAD_SCHEMA_INVALID'
  | 'TITLE_LENGTH_OUT_OF_RANGE';

export interface WechatMpValidationIssue {
  readonly code: WechatMpValidationCode;
  readonly message: string;
  readonly path: string;
  readonly severity: 'blocker';
}

export type WechatMpValidationResult =
  | { readonly issues: readonly []; readonly ok: true; readonly value: WechatMpRenderInput }
  | { readonly issues: readonly WechatMpValidationIssue[]; readonly ok: false };

export type WechatMpRenderResult =
  | { readonly issues: readonly []; readonly ok: true; readonly payload: WechatMpPayload }
  | { readonly issues: readonly WechatMpValidationIssue[]; readonly ok: false };
