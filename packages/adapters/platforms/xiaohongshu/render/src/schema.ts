import { z } from 'zod';

import {
  XIAOHONGSHU_PAYLOAD_SCHEMA_VERSION,
  XIAOHONGSHU_PLATFORM_CODE,
  XIAOHONGSHU_RENDER_RULE_VERSION,
} from './types.js';

const UuidSchema = z.string().uuid();
const unique = (values: readonly unknown[]) => new Set(values).size === values.length;
const unicodeText = (minimum: number, maximum: number) =>
  z.string().refine((value) => {
    const length = [...value].length;
    return length >= minimum && length <= maximum;
  }, `Text must contain ${minimum}-${maximum} Unicode characters`);

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

export const XiaohongshuPlatformMetaSchema = z
  .object({
    cover_text: z.string().max(30),
    note_type: z.string().trim().min(1).max(40),
    topics: z.array(z.string().trim().min(1).max(40)).max(20).refine(unique),
  })
  .strict();
export const XiaohongshuContentSchema = z
  .object({
    blocks: z.array(BlockSchema).min(1),
    citation_map: z.array(CitationMapItemSchema),
    cta: z.string().max(200).nullable(),
    hashtags: z.array(z.string().max(40)).refine(unique),
    platform_code: z.literal(XIAOHONGSHU_PLATFORM_CODE),
    platform_meta: XiaohongshuPlatformMetaSchema,
    summary: z.string().max(240),
    title: unicodeText(2, 80),
  })
  .strict();
export const XiaohongshuCitationLinkSchema = z
  .object({
    citation_id: UuidSchema,
    label: z.string().trim().min(1).max(240),
    url: z.url().refine((value) => /^https?:\/\//u.test(value)),
  })
  .strict();
export const XiaohongshuRenderInputSchema = z
  .object({
    citations: z
      .array(XiaohongshuCitationLinkSchema)
      .max(200)
      .refine((items) => unique(items.map((item) => item.citation_id))),
    content: XiaohongshuContentSchema,
    rule_version: z.literal(XIAOHONGSHU_RENDER_RULE_VERSION),
  })
  .strict();
export const XiaohongshuPayloadSchema = z
  .object({
    body_html: z.string().min(1),
    body_text: z.string().min(1),
    citation_links: z.array(XiaohongshuCitationLinkSchema).max(200),
    cover_text: z.string().max(30),
    note_type: z.string().trim().min(1).max(40),
    platform_code: z.literal(XIAOHONGSHU_PLATFORM_CODE),
    rule_version: z.literal(XIAOHONGSHU_RENDER_RULE_VERSION),
    schema_version: z.literal(XIAOHONGSHU_PAYLOAD_SCHEMA_VERSION),
    title: unicodeText(2, 20),
    topics: z.array(z.string().trim().min(1).max(40)).min(1).max(20).refine(unique),
  })
  .strict();

const definitions = {
  block: {
    additionalProperties: false,
    properties: {
      block_key: { pattern: '^[a-z0-9_-]{1,80}$', type: 'string' },
      block_type: { enum: ['heading', 'paragraph', 'list', 'quote', 'media', 'cta'] },
      text: { type: 'string' },
    },
    required: ['block_key', 'block_type', 'text'],
    type: 'object',
  },
  citation: {
    additionalProperties: false,
    properties: {
      citation_id: { format: 'uuid', type: 'string' },
      label: { maxLength: 240, minLength: 1, type: 'string' },
      url: { format: 'uri', pattern: '^https?://', type: 'string' },
    },
    required: ['citation_id', 'label', 'url'],
    type: 'object',
  },
  citation_map_item: {
    additionalProperties: false,
    properties: {
      citation_ids: { items: { format: 'uuid', type: 'string' }, type: 'array', uniqueItems: true },
      claim_key: { type: 'string' },
      claim_text: { type: 'string' },
    },
    required: ['claim_key', 'claim_text', 'citation_ids'],
    type: 'object',
  },
  content: {
    additionalProperties: false,
    properties: {
      blocks: { items: { $ref: '#/$defs/block' }, minItems: 1, type: 'array' },
      citation_map: { items: { $ref: '#/$defs/citation_map_item' }, type: 'array' },
      cta: { maxLength: 200, type: ['string', 'null'] },
      hashtags: { items: { maxLength: 40, type: 'string' }, type: 'array', uniqueItems: true },
      platform_code: { const: XIAOHONGSHU_PLATFORM_CODE },
      platform_meta: {
        additionalProperties: false,
        properties: {
          cover_text: { maxLength: 30, type: 'string' },
          note_type: { maxLength: 40, minLength: 1, type: 'string' },
          topics: {
            items: { maxLength: 40, minLength: 1, type: 'string' },
            maxItems: 20,
            type: 'array',
            uniqueItems: true,
          },
        },
        required: ['topics', 'cover_text', 'note_type'],
        type: 'object',
      },
      summary: { maxLength: 240, type: 'string' },
      title: { maxLength: 80, minLength: 2, type: 'string' },
    },
    required: [
      'platform_code',
      'title',
      'summary',
      'blocks',
      'hashtags',
      'cta',
      'citation_map',
      'platform_meta',
    ],
    type: 'object',
  },
};

export const XIAOHONGSHU_RENDER_INPUT_JSON_SCHEMA = Object.freeze({
  $id: 'https://geo.example/schemas/xiaohongshu-render-input-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $defs: definitions,
  additionalProperties: false,
  properties: {
    citations: { items: { $ref: '#/$defs/citation' }, maxItems: 200, type: 'array' },
    content: { $ref: '#/$defs/content' },
    rule_version: { const: XIAOHONGSHU_RENDER_RULE_VERSION },
  },
  required: ['rule_version', 'content', 'citations'],
  type: 'object',
});
export const XIAOHONGSHU_PAYLOAD_JSON_SCHEMA = Object.freeze({
  $id: 'https://geo.example/schemas/xiaohongshu-payload-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $defs: definitions,
  additionalProperties: false,
  properties: {
    body_html: { minLength: 1, type: 'string' },
    body_text: { minLength: 1, type: 'string' },
    citation_links: { items: { $ref: '#/$defs/citation' }, maxItems: 200, type: 'array' },
    cover_text: { maxLength: 30, type: 'string' },
    note_type: { maxLength: 40, minLength: 1, type: 'string' },
    platform_code: { const: XIAOHONGSHU_PLATFORM_CODE },
    rule_version: { const: XIAOHONGSHU_RENDER_RULE_VERSION },
    schema_version: { const: XIAOHONGSHU_PAYLOAD_SCHEMA_VERSION },
    title: { maxLength: 20, minLength: 2, type: 'string' },
    topics: {
      items: { maxLength: 40, minLength: 1, type: 'string' },
      maxItems: 20,
      minItems: 1,
      type: 'array',
      uniqueItems: true,
    },
  },
  required: [
    'schema_version',
    'rule_version',
    'platform_code',
    'title',
    'topics',
    'cover_text',
    'note_type',
    'body_html',
    'body_text',
    'citation_links',
  ],
  type: 'object',
});
