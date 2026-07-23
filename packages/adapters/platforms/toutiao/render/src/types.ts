import type { ContentWriterContent } from '@geo-content-os/contracts/skills';

export const TOUTIAO_PLATFORM_CODE = 'toutiao' as const;
export const TOUTIAO_RENDER_RULE_VERSION = 'toutiao-render-rules@1.0.0' as const;
export const TOUTIAO_PAYLOAD_SCHEMA_VERSION = 'toutiao-payload@1' as const;

export interface ToutiaoPlatformMeta {
  readonly content_type: string;
  readonly lead: string;
  readonly tags: readonly string[];
}

export interface ToutiaoCitationLink {
  readonly citation_id: string;
  readonly label: string;
  readonly url: string;
}

export interface ToutiaoContent extends Omit<
  ContentWriterContent,
  'platform_code' | 'platform_meta'
> {
  readonly platform_code: typeof TOUTIAO_PLATFORM_CODE;
  readonly platform_meta: ToutiaoPlatformMeta;
}

export interface ToutiaoRenderInput {
  readonly citations: readonly ToutiaoCitationLink[];
  readonly content: ToutiaoContent;
  readonly rule_version: typeof TOUTIAO_RENDER_RULE_VERSION;
}

export interface ToutiaoPayload {
  readonly body_html: string;
  readonly body_text: string;
  readonly citation_links: readonly ToutiaoCitationLink[];
  readonly content_type: string;
  readonly lead: string;
  readonly platform_code: typeof TOUTIAO_PLATFORM_CODE;
  readonly rule_version: typeof TOUTIAO_RENDER_RULE_VERSION;
  readonly schema_version: typeof TOUTIAO_PAYLOAD_SCHEMA_VERSION;
  readonly tags: readonly string[];
  readonly title: string;
}

export type ToutiaoValidationCode =
  | 'CITATION_LINK_MISSING'
  | 'CLICKBAIT_TITLE'
  | 'LEAD_LENGTH_OUT_OF_RANGE'
  | 'PAYLOAD_SCHEMA_INVALID'
  | 'QUESTION_ANSWER_REQUIRED'
  | 'TIME_SENSITIVE_CITATION_REQUIRED'
  | 'TITLE_LENGTH_OUT_OF_RANGE';

export interface ToutiaoValidationIssue {
  readonly code: ToutiaoValidationCode;
  readonly message: string;
  readonly path: string;
  readonly severity: 'blocker';
}

export type ToutiaoValidationResult =
  | { readonly issues: readonly []; readonly ok: true; readonly value: ToutiaoRenderInput }
  | { readonly issues: readonly ToutiaoValidationIssue[]; readonly ok: false };

export type ToutiaoRenderResult =
  | { readonly issues: readonly []; readonly ok: true; readonly payload: ToutiaoPayload }
  | { readonly issues: readonly ToutiaoValidationIssue[]; readonly ok: false };
