import { z } from 'zod';

import {
  ZHIHU_PAYLOAD_SCHEMA_VERSION,
  ZHIHU_PLATFORM_CODE,
  ZHIHU_RENDER_RULE_VERSION,
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

export const ZhihuPlatformMetaSchema = z
  .object({
    content_type: z.string().trim().min(1).max(40),
    question_id: z.string().trim().min(1).max(120).nullable(),
    topics: z.array(z.string().trim().min(1).max(40)).max(20).refine(unique),
  })
  .strict();

export const ZhihuContentSchema = z
  .object({
    blocks: z.array(BlockSchema).min(1),
    citation_map: z.array(CitationMapItemSchema),
    cta: z.string().max(200).nullable(),
    hashtags: z.array(z.string().max(40)).refine(unique),
    platform_code: z.literal(ZHIHU_PLATFORM_CODE),
    platform_meta: ZhihuPlatformMetaSchema,
    summary: z.string().max(240),
    title: unicodeText(2, 80),
  })
  .strict();

export const ZhihuCitationLinkSchema = z
  .object({
    citation_id: UuidSchema,
    label: z.string().trim().min(1).max(240),
    url: z.url().refine((value) => value.startsWith('https://') || value.startsWith('http://')),
  })
  .strict();

export const ZhihuRenderInputSchema = z
  .object({
    citations: z
      .array(ZhihuCitationLinkSchema)
      .max(200)
      .refine((items) => unique(items.map((item) => item.citation_id))),
    content: ZhihuContentSchema,
    rule_version: z.literal(ZHIHU_RENDER_RULE_VERSION),
  })
  .strict();

export const ZhihuPayloadSchema = z
  .object({
    body_html: z.string().min(1),
    body_text: z.string().min(1),
    citation_links: z.array(ZhihuCitationLinkSchema).max(200),
    content_type: z.string().trim().min(1).max(40),
    platform_code: z.literal(ZHIHU_PLATFORM_CODE),
    question_id: z.string().trim().min(1).max(120).nullable(),
    rule_version: z.literal(ZHIHU_RENDER_RULE_VERSION),
    schema_version: z.literal(ZHIHU_PAYLOAD_SCHEMA_VERSION),
    title: unicodeText(2, 80),
    topics: z.array(z.string().trim().min(1).max(40)).max(20).refine(unique),
  })
  .strict();

export const ZHIHU_RENDER_INPUT_JSON_SCHEMA = Object.freeze({
  $id: 'https://geo.example/schemas/zhihu-render-input-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: {
    citations: { items: { $ref: '#/$defs/citation' }, maxItems: 200, type: 'array' },
    content: { $ref: '#/$defs/content' },
    rule_version: { const: ZHIHU_RENDER_RULE_VERSION },
  },
  required: ['rule_version', 'content', 'citations'],
  type: 'object',
  $defs: schemaDefinitions(),
});

export const ZHIHU_PAYLOAD_JSON_SCHEMA = Object.freeze({
  $id: 'https://geo.example/schemas/zhihu-payload-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: {
    body_html: { minLength: 1, type: 'string' },
    body_text: { minLength: 1, type: 'string' },
    citation_links: { items: { $ref: '#/$defs/citation' }, maxItems: 200, type: 'array' },
    content_type: { maxLength: 40, minLength: 1, type: 'string' },
    platform_code: { const: ZHIHU_PLATFORM_CODE },
    question_id: {
      anyOf: [{ maxLength: 120, minLength: 1, type: 'string' }, { type: 'null' }],
    },
    rule_version: { const: ZHIHU_RENDER_RULE_VERSION },
    schema_version: { const: ZHIHU_PAYLOAD_SCHEMA_VERSION },
    title: { maxLength: 80, minLength: 2, type: 'string' },
    topics: {
      items: { maxLength: 40, minLength: 1, type: 'string' },
      maxItems: 20,
      type: 'array',
      uniqueItems: true,
    },
  },
  required: [
    'schema_version',
    'rule_version',
    'platform_code',
    'title',
    'question_id',
    'content_type',
    'topics',
    'body_html',
    'body_text',
    'citation_links',
  ],
  type: 'object',
  $defs: schemaDefinitions(),
});

function schemaDefinitions() {
  return {
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
        citation_ids: {
          items: { format: 'uuid', type: 'string' },
          type: 'array',
          uniqueItems: true,
        },
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
        platform_code: { const: ZHIHU_PLATFORM_CODE },
        platform_meta: {
          additionalProperties: false,
          properties: {
            content_type: { maxLength: 40, minLength: 1, type: 'string' },
            question_id: {
              anyOf: [{ maxLength: 120, minLength: 1, type: 'string' }, { type: 'null' }],
            },
            topics: {
              items: { maxLength: 40, minLength: 1, type: 'string' },
              maxItems: 20,
              type: 'array',
              uniqueItems: true,
            },
          },
          required: ['question_id', 'content_type', 'topics'],
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
}

function unique(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length;
}

function unicodeText(minimum: number, maximum: number) {
  return z.string().refine((value) => {
    const length = [...value].length;
    return length >= minimum && length <= maximum;
  }, `Text must contain ${minimum}-${maximum} Unicode characters`);
}
