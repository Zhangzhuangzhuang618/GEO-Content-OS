import type { ContentWriterContent } from '@geo-content-os/contracts/skills';

export const DOUYIN_PLATFORM_CODE = 'douyin' as const;
export const DOUYIN_RENDER_RULE_VERSION = 'douyin-render-rules@1.0.0' as const;
export const DOUYIN_PAYLOAD_SCHEMA_VERSION = 'douyin-payload@1' as const;

export interface DouyinStoryboardScene {
  readonly end_second: number;
  readonly scene_key: string;
  readonly start_second: number;
  readonly visual: string;
  readonly voiceover: string;
}

export interface DouyinSubtitle {
  readonly end_second: number;
  readonly start_second: number;
  readonly text: string;
}

export interface DouyinPlatformMeta {
  readonly duration_seconds: number;
  readonly storyboard: readonly DouyinStoryboardScene[];
  readonly subtitles: readonly DouyinSubtitle[];
  readonly topics: readonly string[];
}

export interface DouyinCitationLink {
  readonly citation_id: string;
  readonly label: string;
  readonly url: string;
}

export interface DouyinContent extends Omit<
  ContentWriterContent,
  'platform_code' | 'platform_meta'
> {
  readonly platform_code: typeof DOUYIN_PLATFORM_CODE;
  readonly platform_meta: DouyinPlatformMeta;
}

export interface DouyinRenderInput {
  readonly citations: readonly DouyinCitationLink[];
  readonly content: DouyinContent;
  readonly rule_version: typeof DOUYIN_RENDER_RULE_VERSION;
}

export interface DouyinPayload {
  readonly citation_links: readonly DouyinCitationLink[];
  readonly duration_seconds: number;
  readonly hook: string;
  readonly platform_code: typeof DOUYIN_PLATFORM_CODE;
  readonly rule_version: typeof DOUYIN_RENDER_RULE_VERSION;
  readonly schema_version: typeof DOUYIN_PAYLOAD_SCHEMA_VERSION;
  readonly script_kind: 'script_package';
  readonly script_text: string;
  readonly storyboard: readonly DouyinStoryboardScene[];
  readonly subtitles: readonly DouyinSubtitle[];
  readonly title: string;
  readonly topics: readonly string[];
}

export type DouyinValidationCode =
  | 'CITATION_LINK_MISSING'
  | 'DURATION_MISMATCH'
  | 'HOOK_REQUIRED'
  | 'PAYLOAD_SCHEMA_INVALID'
  | 'PRODUCTION_CLAIM_FORBIDDEN'
  | 'STORYBOARD_REQUIRED'
  | 'SUBTITLE_REQUIRED'
  | 'TOPIC_REQUIRED';

export interface DouyinValidationIssue {
  readonly code: DouyinValidationCode;
  readonly message: string;
  readonly path: string;
  readonly severity: 'blocker';
}

export type DouyinValidationResult =
  | { readonly issues: readonly []; readonly ok: true; readonly value: DouyinRenderInput }
  | { readonly issues: readonly DouyinValidationIssue[]; readonly ok: false };

export type DouyinRenderResult =
  | { readonly issues: readonly []; readonly ok: true; readonly payload: DouyinPayload }
  | { readonly issues: readonly DouyinValidationIssue[]; readonly ok: false };
