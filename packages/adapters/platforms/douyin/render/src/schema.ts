import { z } from 'zod';

import {
  DOUYIN_PAYLOAD_SCHEMA_VERSION,
  DOUYIN_PLATFORM_CODE,
  DOUYIN_RENDER_RULE_VERSION,
} from './types.js';

const UuidSchema = z.string().uuid();
const unique = (values: readonly unknown[]) => new Set(values).size === values.length;
const TimelineSecondSchema = z.number().finite().min(0).max(600);
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

export const DouyinStoryboardSceneSchema = z
  .object({
    end_second: TimelineSecondSchema,
    scene_key: z.string().regex(/^[a-z0-9_-]{1,80}$/u),
    start_second: TimelineSecondSchema,
    visual: z.string().trim().min(1).max(500),
    voiceover: z.string().trim().min(1).max(500),
  })
  .strict();
export const DouyinSubtitleSchema = z
  .object({
    end_second: TimelineSecondSchema,
    start_second: TimelineSecondSchema,
    text: z.string().trim().min(1).max(200),
  })
  .strict();
export const DouyinPlatformMetaSchema = z
  .object({
    duration_seconds: z.number().finite().min(3).max(600),
    storyboard: z.array(DouyinStoryboardSceneSchema).max(100),
    subtitles: z.array(DouyinSubtitleSchema).max(500),
    topics: z.array(z.string().trim().min(1).max(40)).max(20).refine(unique),
  })
  .strict();
export const DouyinContentSchema = z
  .object({
    blocks: z.array(BlockSchema).min(1),
    citation_map: z.array(CitationMapItemSchema),
    cta: z.string().max(200).nullable(),
    hashtags: z.array(z.string().max(40)).refine(unique),
    platform_code: z.literal(DOUYIN_PLATFORM_CODE),
    platform_meta: DouyinPlatformMetaSchema,
    summary: z.string().max(240),
    title: z.string().trim().min(1).max(80),
  })
  .strict();
export const DouyinCitationLinkSchema = z
  .object({
    citation_id: UuidSchema,
    label: z.string().trim().min(1).max(240),
    url: z.url().refine((value) => /^https?:\/\//u.test(value)),
  })
  .strict();
export const DouyinRenderInputSchema = z
  .object({
    citations: z
      .array(DouyinCitationLinkSchema)
      .max(200)
      .refine((items) => unique(items.map((item) => item.citation_id))),
    content: DouyinContentSchema,
    rule_version: z.literal(DOUYIN_RENDER_RULE_VERSION),
  })
  .strict();
export const DouyinPayloadSchema = z
  .object({
    citation_links: z.array(DouyinCitationLinkSchema).max(200),
    duration_seconds: z.number().finite().min(3).max(600),
    hook: z.string().trim().min(1).max(500),
    platform_code: z.literal(DOUYIN_PLATFORM_CODE),
    rule_version: z.literal(DOUYIN_RENDER_RULE_VERSION),
    schema_version: z.literal(DOUYIN_PAYLOAD_SCHEMA_VERSION),
    script_kind: z.literal('script_package'),
    script_text: z.string().min(1),
    storyboard: z.array(DouyinStoryboardSceneSchema).min(1).max(100),
    subtitles: z.array(DouyinSubtitleSchema).min(1).max(500),
    title: z.string().trim().min(1).max(80),
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
  scene: {
    additionalProperties: false,
    properties: {
      end_second: { maximum: 600, minimum: 0, type: 'number' },
      scene_key: { pattern: '^[a-z0-9_-]{1,80}$', type: 'string' },
      start_second: { maximum: 600, minimum: 0, type: 'number' },
      visual: { maxLength: 500, minLength: 1, type: 'string' },
      voiceover: { maxLength: 500, minLength: 1, type: 'string' },
    },
    required: ['scene_key', 'start_second', 'end_second', 'visual', 'voiceover'],
    type: 'object',
  },
  subtitle: {
    additionalProperties: false,
    properties: {
      end_second: { maximum: 600, minimum: 0, type: 'number' },
      start_second: { maximum: 600, minimum: 0, type: 'number' },
      text: { maxLength: 200, minLength: 1, type: 'string' },
    },
    required: ['start_second', 'end_second', 'text'],
    type: 'object',
  },
};
const contentDefinition = {
  additionalProperties: false,
  properties: {
    blocks: { items: { $ref: '#/$defs/block' }, minItems: 1, type: 'array' },
    citation_map: { items: { $ref: '#/$defs/citation_map_item' }, type: 'array' },
    cta: { maxLength: 200, type: ['string', 'null'] },
    hashtags: { items: { maxLength: 40, type: 'string' }, type: 'array', uniqueItems: true },
    platform_code: { const: DOUYIN_PLATFORM_CODE },
    platform_meta: {
      additionalProperties: false,
      properties: {
        duration_seconds: { maximum: 600, minimum: 3, type: 'number' },
        storyboard: { items: { $ref: '#/$defs/scene' }, maxItems: 100, type: 'array' },
        subtitles: { items: { $ref: '#/$defs/subtitle' }, maxItems: 500, type: 'array' },
        topics: {
          items: { maxLength: 40, minLength: 1, type: 'string' },
          maxItems: 20,
          type: 'array',
          uniqueItems: true,
        },
      },
      required: ['duration_seconds', 'storyboard', 'subtitles', 'topics'],
      type: 'object',
    },
    summary: { maxLength: 240, type: 'string' },
    title: { maxLength: 80, minLength: 1, type: 'string' },
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
};

export const DOUYIN_RENDER_INPUT_JSON_SCHEMA = Object.freeze({
  $id: 'https://geo.example/schemas/douyin-render-input-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $defs: { ...definitions, content: contentDefinition },
  additionalProperties: false,
  properties: {
    citations: { items: { $ref: '#/$defs/citation' }, maxItems: 200, type: 'array' },
    content: { $ref: '#/$defs/content' },
    rule_version: { const: DOUYIN_RENDER_RULE_VERSION },
  },
  required: ['rule_version', 'content', 'citations'],
  type: 'object',
});
export const DOUYIN_PAYLOAD_JSON_SCHEMA = Object.freeze({
  $id: 'https://geo.example/schemas/douyin-payload-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $defs: definitions,
  additionalProperties: false,
  properties: {
    citation_links: { items: { $ref: '#/$defs/citation' }, maxItems: 200, type: 'array' },
    duration_seconds: { maximum: 600, minimum: 3, type: 'number' },
    hook: { maxLength: 500, minLength: 1, type: 'string' },
    platform_code: { const: DOUYIN_PLATFORM_CODE },
    rule_version: { const: DOUYIN_RENDER_RULE_VERSION },
    schema_version: { const: DOUYIN_PAYLOAD_SCHEMA_VERSION },
    script_kind: { const: 'script_package' },
    script_text: { minLength: 1, type: 'string' },
    storyboard: { items: { $ref: '#/$defs/scene' }, maxItems: 100, minItems: 1, type: 'array' },
    subtitles: {
      items: { $ref: '#/$defs/subtitle' },
      maxItems: 500,
      minItems: 1,
      type: 'array',
    },
    title: { maxLength: 80, minLength: 1, type: 'string' },
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
    'script_kind',
    'title',
    'hook',
    'duration_seconds',
    'storyboard',
    'subtitles',
    'topics',
    'script_text',
    'citation_links',
  ],
  type: 'object',
});
