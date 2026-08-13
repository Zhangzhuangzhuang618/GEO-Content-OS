import { z } from 'zod';

import {
  SOHU_PAYLOAD_SCHEMA_VERSION,
  SOHU_PLATFORM_CODE,
  SOHU_RENDER_RULE_VERSION,
} from './types.js';

const UuidSchema = z.string().uuid();
const BlockSchema = z
  .object({
    block_key: z.string().regex(/^[a-z0-9_-]{1,80}$/u),
    block_type: z.enum(['heading', 'paragraph', 'list', 'quote', 'media', 'cta']),
    text: z.string(),
  })
  .strict();
const CitationMapItemSchema = z
  .object({
    citation_ids: z.array(UuidSchema).refine(unique),
    claim_key: z.string(),
    claim_text: z.string(),
  })
  .strict();

export const SohuPlatformMetaSchema = z
  .object({
    abstract: z.string().max(240),
    body_asset_ids: z.array(UuidSchema).max(10).refine(unique).optional(),
    content_type: z.string().trim().min(1).max(40),
    cover_asset_id: UuidSchema.nullable().optional(),
  })
  .strict();

export const SohuContentSchema = z
  .object({
    blocks: z.array(BlockSchema).min(1),
    citation_map: z.array(CitationMapItemSchema),
    cta: z.string().max(200).nullable(),
    hashtags: z.array(z.string().max(40)).refine(unique),
    platform_code: z.literal(SOHU_PLATFORM_CODE),
    platform_meta: SohuPlatformMetaSchema,
    summary: z.string().max(240),
    title: unicodeText(5, 72),
  })
  .strict();

export const SohuCitationLinkSchema = z
  .object({
    citation_id: UuidSchema,
    label: z.string().trim().min(1).max(240),
    url: z.url().refine((value) => value.startsWith('https://') || value.startsWith('http://')),
  })
  .strict();

export const SohuRenderInputSchema = z
  .object({
    citations: z
      .array(SohuCitationLinkSchema)
      .max(200)
      .refine((items) => unique(items.map((item) => item.citation_id))),
    content: SohuContentSchema,
    rule_version: z.literal(SOHU_RENDER_RULE_VERSION),
  })
  .strict();

export const SohuPayloadSchema = z
  .object({
    abstract: unicodeText(1, 120),
    ai_generated: z.literal(true),
    body_html: z.string().min(1),
    body_asset_ids: z.array(UuidSchema).max(10).refine(unique),
    body_text: z.string().min(1),
    citation_links: z.array(SohuCitationLinkSchema).max(200),
    content_type: z.string().trim().min(1).max(40),
    cover_asset_id: UuidSchema.nullable(),
    original: z.literal(false),
    platform_code: z.literal(SOHU_PLATFORM_CODE),
    rule_version: z.literal(SOHU_RENDER_RULE_VERSION),
    schema_version: z.literal(SOHU_PAYLOAD_SCHEMA_VERSION),
    title: unicodeText(5, 72),
  })
  .strict();

function unique(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length;
}

function unicodeText(minimum: number, maximum: number) {
  return z.string().refine((value) => {
    const length = [...value].length;
    return length >= minimum && length <= maximum;
  }, `Text must contain ${minimum}-${maximum} Unicode characters`);
}
