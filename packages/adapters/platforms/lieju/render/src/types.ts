import type { ContentWriterContent } from '@geo-content-os/contracts/skills';

export const LIEJU_PLATFORM_CODE = 'lieju' as const;
export const LIEJU_RENDER_RULE_VERSION = 'lieju-render-rules@1.0.0' as const;
export const LIEJU_PAYLOAD_SCHEMA_VERSION = 'lieju-payload@1' as const;

export interface LiejuPlatformMeta {
  readonly content_type: 'logistics_freight';
  readonly cover_asset_id?: string | null;
}

export interface LiejuCitationLink {
  readonly citation_id: string;
  readonly label: string;
  readonly url: string;
}

export interface LiejuContent extends Omit<
  ContentWriterContent,
  'platform_code' | 'platform_meta'
> {
  readonly platform_code: typeof LIEJU_PLATFORM_CODE;
  readonly platform_meta: LiejuPlatformMeta;
}

export interface LiejuRenderInput {
  readonly citations: readonly LiejuCitationLink[];
  readonly content: LiejuContent;
  readonly rule_version: typeof LIEJU_RENDER_RULE_VERSION;
}

export interface LiejuPayload {
  readonly body_text: string;
  readonly citation_links: readonly LiejuCitationLink[];
  readonly content_type: 'logistics_freight';
  readonly cover_asset_id: string | null;
  readonly platform_code: typeof LIEJU_PLATFORM_CODE;
  readonly rule_version: typeof LIEJU_RENDER_RULE_VERSION;
  readonly schema_version: typeof LIEJU_PAYLOAD_SCHEMA_VERSION;
  readonly title: string;
}

export type LiejuValidationCode =
  | 'BODY_LENGTH_OUT_OF_RANGE'
  | 'CONTACT_INFO_FORBIDDEN'
  | 'PAYLOAD_SCHEMA_INVALID'
  | 'PROHIBITED_TERM'
  | 'SEGMENTATION_REQUIRED'
  | 'TITLE_LENGTH_OUT_OF_RANGE';

export interface LiejuValidationIssue {
  readonly code: LiejuValidationCode;
  readonly message: string;
  readonly path: string;
  readonly severity: 'blocker';
}

export type LiejuValidationResult =
  | { readonly issues: readonly []; readonly ok: true; readonly value: LiejuRenderInput }
  | { readonly issues: readonly LiejuValidationIssue[]; readonly ok: false };

export type LiejuRenderResult =
  | { readonly issues: readonly []; readonly ok: true; readonly payload: LiejuPayload }
  | { readonly issues: readonly LiejuValidationIssue[]; readonly ok: false };
