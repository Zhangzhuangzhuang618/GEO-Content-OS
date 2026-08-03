import type { ContentWriterContent } from '@geo-content-os/contracts/skills';

export const OFFICIAL_SITE_PLATFORM_CODE = 'official_site' as const;
export const OFFICIAL_SITE_RENDER_RULE_VERSION = 'official-site-render-rules@1.1.0' as const;
export const OFFICIAL_SITE_PAYLOAD_SCHEMA_VERSION = 'official-site-payload@2' as const;

export interface OfficialSiteFaqItem {
  readonly answer: string;
  readonly question: string;
}

export interface OfficialSitePlatformMeta {
  readonly faq: readonly OfficialSiteFaqItem[];
  readonly meta_description: string;
  readonly schema_org: Readonly<Record<string, unknown>>;
  readonly slug: string;
}

export interface OfficialSiteCitationLink {
  readonly citation_id: string;
  readonly label: string;
  readonly url: string;
}

export interface OfficialSiteMediaAsset {
  readonly alt_text: string;
  readonly position: number;
  readonly role: 'body' | 'cover';
  readonly url: string;
}

export interface OfficialSiteContent extends Omit<
  ContentWriterContent,
  'platform_code' | 'platform_meta'
> {
  readonly platform_code: typeof OFFICIAL_SITE_PLATFORM_CODE;
  readonly platform_meta: OfficialSitePlatformMeta;
}

export interface OfficialSiteRenderInput {
  readonly citations: readonly OfficialSiteCitationLink[];
  readonly content: OfficialSiteContent;
  readonly media_assets?: readonly OfficialSiteMediaAsset[];
  readonly rule_version: typeof OFFICIAL_SITE_RENDER_RULE_VERSION;
}

export interface OfficialSitePayload {
  readonly body_html: string;
  readonly citation_links: readonly OfficialSiteCitationLink[];
  readonly faq: readonly OfficialSiteFaqItem[];
  readonly html: string;
  readonly markdown: string;
  readonly meta_description: string;
  readonly platform_code: typeof OFFICIAL_SITE_PLATFORM_CODE;
  readonly rule_version: typeof OFFICIAL_SITE_RENDER_RULE_VERSION;
  readonly schema_org: Readonly<Record<string, unknown>>;
  readonly schema_version: typeof OFFICIAL_SITE_PAYLOAD_SCHEMA_VERSION;
  readonly seo_keywords: readonly string[];
  readonly slug: string;
  readonly summary: string;
  readonly title: string;
}

export type OfficialSiteValidationCode =
  | 'BODY_LENGTH_OUT_OF_RANGE'
  | 'CITATION_LINK_MISSING'
  | 'FAQ_REQUIRED'
  | 'FIRST_PARAGRAPH_REQUIRED'
  | 'H2_REQUIRED'
  | 'OTHER_COMPANY_NAME_FORBIDDEN'
  | 'PAYLOAD_SCHEMA_INVALID'
  | 'SCHEMA_ORG_REQUIRED'
  | 'TITLE_LENGTH_OUT_OF_RANGE';

export interface OfficialSiteValidationIssue {
  readonly code: OfficialSiteValidationCode;
  readonly message: string;
  readonly path: string;
  readonly severity: 'blocker';
}

export type OfficialSiteValidationResult =
  | { readonly issues: readonly []; readonly ok: true; readonly value: OfficialSiteRenderInput }
  | { readonly issues: readonly OfficialSiteValidationIssue[]; readonly ok: false };

export type OfficialSiteRenderResult =
  | { readonly issues: readonly []; readonly ok: true; readonly payload: OfficialSitePayload }
  | { readonly issues: readonly OfficialSiteValidationIssue[]; readonly ok: false };
