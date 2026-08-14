import { z } from 'zod';

import {
  LIEJU_PAYLOAD_SCHEMA_VERSION,
  LIEJU_PLATFORM_CODE,
  LIEJU_RENDER_RULE_VERSION,
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

export const LiejuPlatformMetaSchema = z
  .object({
    content_type: z.literal('logistics_freight'),
    cover_asset_id: UuidSchema.nullable().optional(),
  })
  .strict();

export const LiejuContentSchema = z
  .object({
    blocks: z.array(BlockSchema).min(1),
    citation_map: z.array(CitationMapItemSchema),
    cta: z.string().max(200).nullable(),
    hashtags: z.array(z.string().max(40)).refine(unique),
    platform_code: z.literal(LIEJU_PLATFORM_CODE),
    platform_meta: LiejuPlatformMetaSchema,
    summary: z.string().max(240),
    title: unicodeText(5, 30),
  })
  .strict();

export const LiejuCitationLinkSchema = z
  .object({
    citation_id: UuidSchema,
    label: z.string().trim().min(1).max(240),
    url: z.url().refine((value) => value.startsWith('https://') || value.startsWith('http://')),
  })
  .strict();

export const LiejuRenderInputSchema = z
  .object({
    citations: z
      .array(LiejuCitationLinkSchema)
      .max(200)
      .refine((items) => unique(items.map((item) => item.citation_id))),
    content: LiejuContentSchema,
    rule_version: z.literal(LIEJU_RENDER_RULE_VERSION),
  })
  .strict();

export const LiejuPayloadSchema = z
  .object({
    body_text: unicodeText(600, 8_000),
    citation_links: z.array(LiejuCitationLinkSchema).max(200),
    content_type: z.literal('logistics_freight'),
    cover_asset_id: UuidSchema.nullable(),
    platform_code: z.literal(LIEJU_PLATFORM_CODE),
    rule_version: z.literal(LIEJU_RENDER_RULE_VERSION),
    schema_version: z.literal(LIEJU_PAYLOAD_SCHEMA_VERSION),
    title: unicodeText(5, 30),
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
