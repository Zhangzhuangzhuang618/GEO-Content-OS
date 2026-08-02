import { z } from 'zod';

import {
  BAIJIAHAO_PAYLOAD_SCHEMA_VERSION,
  BAIJIAHAO_PLATFORM_CODE,
  BAIJIAHAO_RENDER_RULE_VERSION,
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

export const BaijiahaoPlatformMetaSchema = z
  .object({
    abstract: z.string().max(240),
    body_asset_ids: z.array(UuidSchema).max(10).refine(unique).optional(),
    content_type: z.string().trim().min(1).max(40),
    cover_asset_id: UuidSchema.nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).refine(unique),
  })
  .strict();

export const BaijiahaoContentSchema = z
  .object({
    blocks: z.array(BlockSchema).min(1),
    citation_map: z.array(CitationMapItemSchema),
    cta: z.string().max(200).nullable(),
    hashtags: z.array(z.string().max(40)).refine(unique),
    platform_code: z.literal(BAIJIAHAO_PLATFORM_CODE),
    platform_meta: BaijiahaoPlatformMetaSchema,
    summary: z.string().max(240),
    title: unicodeText(2, 80),
  })
  .strict();

export const BaijiahaoCitationLinkSchema = z
  .object({
    citation_id: UuidSchema,
    label: z.string().trim().min(1).max(240),
    url: z.url().refine((value) => value.startsWith('https://') || value.startsWith('http://')),
  })
  .strict();

export const BaijiahaoRenderInputSchema = z
  .object({
    citations: z
      .array(BaijiahaoCitationLinkSchema)
      .max(200)
      .refine((items) => unique(items.map((item) => item.citation_id))),
    content: BaijiahaoContentSchema,
    rule_version: z.literal(BAIJIAHAO_RENDER_RULE_VERSION),
  })
  .strict();

export const BaijiahaoPayloadSchema = z
  .object({
    abstract: unicodeText(1, 120),
    body_html: z.string().min(1),
    body_asset_ids: z.array(UuidSchema).max(10).refine(unique),
    body_text: z.string().min(1),
    citation_links: z.array(BaijiahaoCitationLinkSchema).max(200),
    content_type: z.string().trim().min(1).max(40),
    cover_asset_id: UuidSchema.nullable(),
    platform_code: z.literal(BAIJIAHAO_PLATFORM_CODE),
    rule_version: z.literal(BAIJIAHAO_RENDER_RULE_VERSION),
    schema_version: z.literal(BAIJIAHAO_PAYLOAD_SCHEMA_VERSION),
    tags: z.array(z.string().trim().min(1).max(40)).min(3).max(8).refine(unique),
    title: unicodeText(2, 40),
  })
  .strict();

export const BAIJIAHAO_RENDER_INPUT_JSON_SCHEMA = Object.freeze({
  $id: 'https://geo.example/schemas/baijiahao-render-input-2.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: {
    citations: { items: { $ref: '#/$defs/citation' }, maxItems: 200, type: 'array' },
    content: { $ref: '#/$defs/content' },
    rule_version: { const: BAIJIAHAO_RENDER_RULE_VERSION },
  },
  required: ['rule_version', 'content', 'citations'],
  type: 'object',
  $defs: schemaDefinitions(),
});

export const BAIJIAHAO_PAYLOAD_JSON_SCHEMA = Object.freeze({
  $id: 'https://geo.example/schemas/baijiahao-payload-2.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: {
    abstract: { maxLength: 120, minLength: 1, type: 'string' },
    body_html: { minLength: 1, type: 'string' },
    body_asset_ids: {
      items: { format: 'uuid', type: 'string' },
      maxItems: 10,
      type: 'array',
      uniqueItems: true,
    },
    body_text: { minLength: 1, type: 'string' },
    citation_links: { items: { $ref: '#/$defs/citation' }, maxItems: 200, type: 'array' },
    content_type: { maxLength: 40, minLength: 1, type: 'string' },
    cover_asset_id: { anyOf: [{ format: 'uuid', type: 'string' }, { type: 'null' }] },
    platform_code: { const: BAIJIAHAO_PLATFORM_CODE },
    rule_version: { const: BAIJIAHAO_RENDER_RULE_VERSION },
    schema_version: { const: BAIJIAHAO_PAYLOAD_SCHEMA_VERSION },
    tags: {
      items: { maxLength: 40, minLength: 1, type: 'string' },
      maxItems: 8,
      minItems: 3,
      type: 'array',
      uniqueItems: true,
    },
    title: { maxLength: 40, minLength: 2, type: 'string' },
  },
  required: [
    'schema_version',
    'rule_version',
    'platform_code',
    'title',
    'abstract',
    'tags',
    'content_type',
    'body_html',
    'body_asset_ids',
    'body_text',
    'citation_links',
    'cover_asset_id',
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
        platform_code: { const: BAIJIAHAO_PLATFORM_CODE },
        platform_meta: {
          additionalProperties: false,
          properties: {
            abstract: { maxLength: 240, type: 'string' },
            body_asset_ids: {
              items: { format: 'uuid', type: 'string' },
              maxItems: 10,
              type: 'array',
              uniqueItems: true,
            },
            content_type: { maxLength: 40, minLength: 1, type: 'string' },
            cover_asset_id: {
              anyOf: [{ format: 'uuid', type: 'string' }, { type: 'null' }],
            },
            tags: {
              items: { maxLength: 40, minLength: 1, type: 'string' },
              maxItems: 20,
              type: 'array',
              uniqueItems: true,
            },
          },
          required: ['abstract', 'tags', 'content_type'],
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
