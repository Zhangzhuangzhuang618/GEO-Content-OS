import { z } from 'zod';

import {
  DOUYIN_IMAGE_NOTE_PAYLOAD_SCHEMA_VERSION,
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
export const DouyinScriptPlatformMetaSchema = z
  .object({
    content_kind: z.literal('script_package').optional(),
    duration_seconds: z.number().finite().min(3).max(600),
    storyboard: z.array(DouyinStoryboardSceneSchema).max(100),
    subtitles: z.array(DouyinSubtitleSchema).max(500),
    topics: z.array(z.string().trim().min(1).max(40)).max(20).refine(unique),
  })
  .strict();
export const DouyinNoteCardSchema = z
  .object({
    body: z.string().trim().min(1).max(240),
    card_key: z.string().regex(/^[a-z0-9_-]{1,80}$/u),
    heading: z.string().trim().min(1).max(36),
    kind: z.enum(['cover', 'body', 'summary']),
  })
  .strict();
export const DouyinImageNotePlatformMetaSchema = z
  .object({
    cards: z.array(DouyinNoteCardSchema).min(5).max(10),
    content_kind: z.literal('image_note'),
    description: z.string().trim().min(1).max(1_000),
    image_asset_ids: z.array(UuidSchema).min(5).max(10).refine(unique).optional(),
    topics: z.array(z.string().trim().min(1).max(40)).min(1).max(20).refine(unique),
  })
  .strict();
export const DouyinPlatformMetaSchema = z.union([
  DouyinImageNotePlatformMetaSchema,
  DouyinScriptPlatformMetaSchema,
]);
const DouyinContentBaseShape = {
  blocks: z.array(BlockSchema).min(1),
  citation_map: z.array(CitationMapItemSchema),
  cta: z.string().max(200).nullable(),
  hashtags: z.array(z.string().max(40)).refine(unique),
  platform_code: z.literal(DOUYIN_PLATFORM_CODE),
  summary: z.string().max(240),
} as const;
export const DouyinContentSchema = z.union([
  z
    .object({
      ...DouyinContentBaseShape,
      platform_meta: DouyinImageNotePlatformMetaSchema,
      title: z.string().trim().min(2).max(20),
    })
    .strict(),
  z
    .object({
      ...DouyinContentBaseShape,
      platform_meta: DouyinScriptPlatformMetaSchema,
      title: z.string().trim().min(1).max(80),
    })
    .strict(),
]);
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
export const DouyinScriptPayloadSchema = z
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
export const DouyinImageNotePayloadSchema = z
  .object({
    ai_generated: z.literal(true),
    cards: z.array(DouyinNoteCardSchema).min(5).max(10),
    citation_links: z.array(DouyinCitationLinkSchema).max(200),
    content_kind: z.literal('image_note'),
    description: z.string().trim().min(1).max(1_000),
    image_asset_ids: z.array(UuidSchema).min(5).max(10).refine(unique),
    platform_code: z.literal(DOUYIN_PLATFORM_CODE),
    rule_version: z.literal(DOUYIN_RENDER_RULE_VERSION),
    schema_version: z.literal(DOUYIN_IMAGE_NOTE_PAYLOAD_SCHEMA_VERSION),
    title: z.string().trim().min(2).max(20),
    topics: z.array(z.string().trim().min(1).max(40)).min(1).max(20).refine(unique),
  })
  .strict();
export const DouyinPayloadSchema = z.union([
  DouyinImageNotePayloadSchema,
  DouyinScriptPayloadSchema,
]);

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
  note_card: {
    additionalProperties: false,
    properties: {
      body: { maxLength: 240, minLength: 1, type: 'string' },
      card_key: { pattern: '^[a-z0-9_-]{1,80}$', type: 'string' },
      heading: { maxLength: 36, minLength: 1, type: 'string' },
      kind: { enum: ['cover', 'body', 'summary'] },
    },
    required: ['card_key', 'kind', 'heading', 'body'],
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
} as const;

const scriptPlatformMetaDefinition = {
  additionalProperties: false,
  properties: {
    content_kind: { const: 'script_package' },
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
} as const;

const imageNotePlatformMetaDefinition = {
  additionalProperties: false,
  properties: {
    cards: { items: { $ref: '#/$defs/note_card' }, maxItems: 10, minItems: 5, type: 'array' },
    content_kind: { const: 'image_note' },
    description: { maxLength: 1_000, minLength: 1, type: 'string' },
    image_asset_ids: {
      items: { format: 'uuid', type: 'string' },
      maxItems: 10,
      minItems: 5,
      type: 'array',
      uniqueItems: true,
    },
    topics: {
      items: { maxLength: 40, minLength: 1, type: 'string' },
      maxItems: 20,
      minItems: 1,
      type: 'array',
      uniqueItems: true,
    },
  },
  required: ['content_kind', 'description', 'cards', 'topics'],
  type: 'object',
} as const;

const contentBaseProperties = {
  blocks: { items: { $ref: '#/$defs/block' }, minItems: 1, type: 'array' },
  citation_map: { items: { $ref: '#/$defs/citation_map_item' }, type: 'array' },
  cta: { maxLength: 200, type: ['string', 'null'] },
  hashtags: { items: { maxLength: 40, type: 'string' }, type: 'array', uniqueItems: true },
  platform_code: { const: DOUYIN_PLATFORM_CODE },
  summary: { maxLength: 240, type: 'string' },
} as const;
const contentRequired = [
  'platform_code',
  'title',
  'summary',
  'blocks',
  'hashtags',
  'cta',
  'citation_map',
  'platform_meta',
] as const;
const contentDefinition = {
  oneOf: [
    {
      additionalProperties: false,
      properties: {
        ...contentBaseProperties,
        platform_meta: imageNotePlatformMetaDefinition,
        title: { maxLength: 20, minLength: 2, type: 'string' },
      },
      required: contentRequired,
      type: 'object',
    },
    {
      additionalProperties: false,
      properties: {
        ...contentBaseProperties,
        platform_meta: scriptPlatformMetaDefinition,
        title: { maxLength: 80, minLength: 1, type: 'string' },
      },
      required: contentRequired,
      type: 'object',
    },
  ],
} as const;

const scriptPayloadDefinition = {
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
} as const;

const imageNotePayloadDefinition = {
  additionalProperties: false,
  properties: {
    ai_generated: { const: true },
    cards: { items: { $ref: '#/$defs/note_card' }, maxItems: 10, minItems: 5, type: 'array' },
    citation_links: { items: { $ref: '#/$defs/citation' }, maxItems: 200, type: 'array' },
    content_kind: { const: 'image_note' },
    description: { maxLength: 1_000, minLength: 1, type: 'string' },
    image_asset_ids: {
      items: { format: 'uuid', type: 'string' },
      maxItems: 10,
      minItems: 5,
      type: 'array',
      uniqueItems: true,
    },
    platform_code: { const: DOUYIN_PLATFORM_CODE },
    rule_version: { const: DOUYIN_RENDER_RULE_VERSION },
    schema_version: { const: DOUYIN_IMAGE_NOTE_PAYLOAD_SCHEMA_VERSION },
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
    'content_kind',
    'title',
    'description',
    'cards',
    'image_asset_ids',
    'topics',
    'citation_links',
    'ai_generated',
  ],
  type: 'object',
} as const;

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
  $defs: {
    ...definitions,
    image_note_payload: imageNotePayloadDefinition,
    script_payload: scriptPayloadDefinition,
  },
  oneOf: [{ $ref: '#/$defs/image_note_payload' }, { $ref: '#/$defs/script_payload' }],
});
