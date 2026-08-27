import type { ContentWriterContent } from '@geo-content-os/contracts/skills';

export const DOUYIN_PLATFORM_CODE = 'douyin' as const;
export const DOUYIN_RENDER_RULE_VERSION = 'douyin-render-rules@1.0.0' as const;
export const DOUYIN_PAYLOAD_SCHEMA_VERSION = 'douyin-payload@1' as const;
export const DOUYIN_IMAGE_NOTE_PAYLOAD_SCHEMA_VERSION = 'douyin-image-note-payload@1' as const;

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

export interface DouyinScriptPlatformMeta {
  readonly content_kind?: 'script_package';
  readonly duration_seconds: number;
  readonly storyboard: readonly DouyinStoryboardScene[];
  readonly subtitles: readonly DouyinSubtitle[];
  readonly topics: readonly string[];
}

export interface DouyinNoteCard {
  readonly body: string;
  readonly card_key: string;
  readonly heading: string;
  readonly kind: 'cover' | 'body' | 'summary';
}

export interface DouyinImageNotePlatformMeta {
  readonly cards: readonly DouyinNoteCard[];
  readonly content_kind: 'image_note';
  readonly description: string;
  readonly image_asset_ids?: readonly string[];
  readonly topics: readonly string[];
}

export type DouyinPlatformMeta = DouyinScriptPlatformMeta | DouyinImageNotePlatformMeta;

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

export interface DouyinScriptPayload {
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

export interface DouyinImageNotePayload {
  readonly ai_generated: true;
  readonly cards: readonly DouyinNoteCard[];
  readonly citation_links: readonly DouyinCitationLink[];
  readonly content_kind: 'image_note';
  readonly description: string;
  readonly image_asset_ids: readonly string[];
  readonly platform_code: typeof DOUYIN_PLATFORM_CODE;
  readonly rule_version: typeof DOUYIN_RENDER_RULE_VERSION;
  readonly schema_version: typeof DOUYIN_IMAGE_NOTE_PAYLOAD_SCHEMA_VERSION;
  readonly title: string;
  readonly topics: readonly string[];
}

export type DouyinPayload = DouyinScriptPayload | DouyinImageNotePayload;

export type DouyinValidationCode =
  | 'CARD_ASSET_COUNT_MISMATCH'
  | 'CARD_ORDER_INVALID'
  | 'CAPTION_LENGTH_EXCEEDED'
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
