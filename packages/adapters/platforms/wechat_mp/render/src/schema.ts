import { z } from 'zod';

import {
  WECHAT_MP_PAYLOAD_SCHEMA_VERSION,
  WECHAT_MP_PLATFORM_CODE,
  WECHAT_MP_RENDER_RULE_VERSION,
} from './types.js';

const UuidSchema = z.string().uuid();
const unique = (values: readonly unknown[]) => new Set(values).size === values.length;
const unicodeText = (minimum: number, maximum: number) =>
  z.string().refine((value) => {
    const length = [...value].length;
    return length >= minimum && length <= maximum;
  }, `Text must contain ${minimum}-${maximum} Unicode characters`);
const HttpUrlSchema = z.url().refine((value) => /^https?:\/\//u.test(value));

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

export const WechatMpPlatformMetaSchema = z
  .object({
    author: z.string().max(64),
    cover_asset_id: UuidSchema,
    digest: z.string().max(240),
  })
  .strict();
export const WechatMpContentSchema = z
  .object({
    blocks: z.array(BlockSchema).min(1),
    citation_map: z.array(CitationMapItemSchema),
    cta: z.string().max(200).nullable(),
    hashtags: z.array(z.string().max(40)).refine(unique),
    platform_code: z.literal(WECHAT_MP_PLATFORM_CODE),
    platform_meta: WechatMpPlatformMetaSchema,
    summary: z.string().max(240),
    title: unicodeText(2, 80),
  })
  .strict();
export const WechatMpCitationLinkSchema = z
  .object({
    citation_id: UuidSchema,
    label: z.string().trim().min(1).max(240),
    url: HttpUrlSchema,
  })
  .strict();
export const WechatMpInternalLinkSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    url: HttpUrlSchema,
  })
  .strict();
export const WechatMpRenderInputSchema = z
  .object({
    citations: z
      .array(WechatMpCitationLinkSchema)
      .max(200)
      .refine((items) => unique(items.map((item) => item.citation_id))),
    content: WechatMpContentSchema,
    internal_links: z
      .array(WechatMpInternalLinkSchema)
      .max(20)
      .refine((items) => unique(items.map((item) => item.url))),
    rule_version: z.literal(WECHAT_MP_RENDER_RULE_VERSION),
  })
  .strict();
export const WechatMpPayloadSchema = z
  .object({
    author: z.string().trim().min(1).max(64),
    body_html: z.string().min(1),
    body_text: z.string().min(1),
    citation_links: z.array(WechatMpCitationLinkSchema).max(200),
    cover_asset_id: UuidSchema,
    cta: z.string().trim().min(1).max(200),
    digest: z.string().trim().min(1).max(240),
    internal_links: z.array(WechatMpInternalLinkSchema).min(1).max(20),
    platform_code: z.literal(WECHAT_MP_PLATFORM_CODE),
    rule_version: z.literal(WECHAT_MP_RENDER_RULE_VERSION),
    schema_version: z.literal(WECHAT_MP_PAYLOAD_SCHEMA_VERSION),
    title: unicodeText(2, 64),
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
      platform_code: { const: WECHAT_MP_PLATFORM_CODE },
      platform_meta: {
        additionalProperties: false,
        properties: {
          author: { maxLength: 64, type: 'string' },
          cover_asset_id: { format: 'uuid', type: 'string' },
          digest: { maxLength: 240, type: 'string' },
        },
        required: ['digest', 'author', 'cover_asset_id'],
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
  internal_link: {
    additionalProperties: false,
    properties: {
      label: { maxLength: 120, minLength: 1, type: 'string' },
      url: { format: 'uri', pattern: '^https?://', type: 'string' },
    },
    required: ['label', 'url'],
    type: 'object',
  },
};

export const WECHAT_MP_RENDER_INPUT_JSON_SCHEMA = Object.freeze({
  $id: 'https://geo.example/schemas/wechat-mp-render-input-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $defs: definitions,
  additionalProperties: false,
  properties: {
    citations: { items: { $ref: '#/$defs/citation' }, maxItems: 200, type: 'array' },
    content: { $ref: '#/$defs/content' },
    internal_links: {
      items: { $ref: '#/$defs/internal_link' },
      maxItems: 20,
      type: 'array',
      uniqueItems: true,
    },
    rule_version: { const: WECHAT_MP_RENDER_RULE_VERSION },
  },
  required: ['rule_version', 'content', 'citations', 'internal_links'],
  type: 'object',
});
export const WECHAT_MP_PAYLOAD_JSON_SCHEMA = Object.freeze({
  $id: 'https://geo.example/schemas/wechat-mp-payload-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $defs: definitions,
  additionalProperties: false,
  properties: {
    author: { maxLength: 64, minLength: 1, type: 'string' },
    body_html: { minLength: 1, type: 'string' },
    body_text: { minLength: 1, type: 'string' },
    citation_links: { items: { $ref: '#/$defs/citation' }, maxItems: 200, type: 'array' },
    cover_asset_id: { format: 'uuid', type: 'string' },
    cta: { maxLength: 200, minLength: 1, type: 'string' },
    digest: { maxLength: 240, minLength: 1, type: 'string' },
    internal_links: {
      items: { $ref: '#/$defs/internal_link' },
      maxItems: 20,
      minItems: 1,
      type: 'array',
    },
    platform_code: { const: WECHAT_MP_PLATFORM_CODE },
    rule_version: { const: WECHAT_MP_RENDER_RULE_VERSION },
    schema_version: { const: WECHAT_MP_PAYLOAD_SCHEMA_VERSION },
    title: { maxLength: 64, minLength: 2, type: 'string' },
  },
  required: [
    'schema_version',
    'rule_version',
    'platform_code',
    'title',
    'digest',
    'author',
    'cover_asset_id',
    'cta',
    'body_html',
    'body_text',
    'internal_links',
    'citation_links',
  ],
  type: 'object',
});
