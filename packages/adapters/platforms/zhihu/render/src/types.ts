import type { ContentWriterContent } from '@geo-content-os/contracts/skills';

export const ZHIHU_PLATFORM_CODE = 'zhihu' as const;
export const ZHIHU_RENDER_RULE_VERSION = 'zhihu-render-rules@1.0.0' as const;
export const ZHIHU_PAYLOAD_SCHEMA_VERSION = 'zhihu-payload@1' as const;

export interface ZhihuPlatformMeta {
  readonly content_type: string;
  readonly question_id: string | null;
  readonly topics: readonly string[];
}

export interface ZhihuCitationLink {
  readonly citation_id: string;
  readonly label: string;
  readonly url: string;
}

export interface ZhihuContent extends Omit<
  ContentWriterContent,
  'platform_code' | 'platform_meta'
> {
  readonly platform_code: typeof ZHIHU_PLATFORM_CODE;
  readonly platform_meta: ZhihuPlatformMeta;
}

export interface ZhihuRenderInput {
  readonly citations: readonly ZhihuCitationLink[];
  readonly content: ZhihuContent;
  readonly rule_version: typeof ZHIHU_RENDER_RULE_VERSION;
}

export interface ZhihuPayload {
  readonly body_html: string;
  readonly body_text: string;
  readonly citation_links: readonly ZhihuCitationLink[];
  readonly content_type: string;
  readonly platform_code: typeof ZHIHU_PLATFORM_CODE;
  readonly question_id: string | null;
  readonly rule_version: typeof ZHIHU_RENDER_RULE_VERSION;
  readonly schema_version: typeof ZHIHU_PAYLOAD_SCHEMA_VERSION;
  readonly title: string;
  readonly topics: readonly string[];
}

export type ZhihuValidationCode =
  | 'BOUNDARY_OR_COUNTEREXAMPLE_REQUIRED'
  | 'CITATION_LINK_MISSING'
  | 'DIRECT_ANSWER_REQUIRED'
  | 'MARKETING_TONE_FORBIDDEN'
  | 'PAYLOAD_SCHEMA_INVALID';

export interface ZhihuValidationIssue {
  readonly code: ZhihuValidationCode;
  readonly message: string;
  readonly path: string;
  readonly severity: 'blocker';
}

export type ZhihuValidationResult =
  | { readonly issues: readonly []; readonly ok: true; readonly value: ZhihuRenderInput }
  | { readonly issues: readonly ZhihuValidationIssue[]; readonly ok: false };

export type ZhihuRenderResult =
  | { readonly issues: readonly []; readonly ok: true; readonly payload: ZhihuPayload }
  | { readonly issues: readonly ZhihuValidationIssue[]; readonly ok: false };
