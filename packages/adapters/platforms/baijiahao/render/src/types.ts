import type { ContentWriterContent } from '@geo-content-os/contracts/skills';

export const BAIJIAHAO_PLATFORM_CODE = 'baijiahao' as const;
export const BAIJIAHAO_RENDER_RULE_VERSION = 'baijiahao-render-rules@1.0.0' as const;
export const BAIJIAHAO_PAYLOAD_SCHEMA_VERSION = 'baijiahao-payload@1' as const;

export interface BaijiahaoPlatformMeta {
  readonly abstract: string;
  readonly content_type: string;
  readonly tags: readonly string[];
}

export interface BaijiahaoCitationLink {
  readonly citation_id: string;
  readonly label: string;
  readonly url: string;
}

export interface BaijiahaoContent extends Omit<
  ContentWriterContent,
  'platform_code' | 'platform_meta'
> {
  readonly platform_code: typeof BAIJIAHAO_PLATFORM_CODE;
  readonly platform_meta: BaijiahaoPlatformMeta;
}

export interface BaijiahaoRenderInput {
  readonly citations: readonly BaijiahaoCitationLink[];
  readonly content: BaijiahaoContent;
  readonly rule_version: typeof BAIJIAHAO_RENDER_RULE_VERSION;
}

export interface BaijiahaoPayload {
  readonly abstract: string;
  readonly body_html: string;
  readonly body_text: string;
  readonly citation_links: readonly BaijiahaoCitationLink[];
  readonly content_type: string;
  readonly platform_code: typeof BAIJIAHAO_PLATFORM_CODE;
  readonly rule_version: typeof BAIJIAHAO_RENDER_RULE_VERSION;
  readonly schema_version: typeof BAIJIAHAO_PAYLOAD_SCHEMA_VERSION;
  readonly tags: readonly string[];
  readonly title: string;
}

export type BaijiahaoValidationCode =
  | 'ABSTRACT_LENGTH_OUT_OF_RANGE'
  | 'CITATION_LINK_MISSING'
  | 'PAYLOAD_SCHEMA_INVALID'
  | 'SEGMENTATION_REQUIRED'
  | 'TAG_COUNT_OUT_OF_RANGE'
  | 'TIME_REFERENCE_AMBIGUOUS'
  | 'TITLE_LENGTH_OUT_OF_RANGE';

export interface BaijiahaoValidationIssue {
  readonly code: BaijiahaoValidationCode;
  readonly message: string;
  readonly path: string;
  readonly severity: 'blocker';
}

export type BaijiahaoValidationResult =
  | { readonly issues: readonly []; readonly ok: true; readonly value: BaijiahaoRenderInput }
  | { readonly issues: readonly BaijiahaoValidationIssue[]; readonly ok: false };

export type BaijiahaoRenderResult =
  | { readonly issues: readonly []; readonly ok: true; readonly payload: BaijiahaoPayload }
  | { readonly issues: readonly BaijiahaoValidationIssue[]; readonly ok: false };
