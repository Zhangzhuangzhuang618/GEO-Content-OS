import { z } from 'zod';

import {
  OFFICIAL_SITE_PAYLOAD_SCHEMA_VERSION,
  OFFICIAL_SITE_PLATFORM_CODE,
  OFFICIAL_SITE_RENDER_RULE_VERSION,
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

export const OfficialSiteFaqItemSchema = z
  .object({ answer: z.string().trim().min(1), question: z.string().trim().min(1) })
  .strict();

export const OfficialSitePlatformMetaSchema = z
  .object({
    faq: z.array(OfficialSiteFaqItemSchema).min(1).max(20),
    meta_description: z.string().trim().min(1).max(240),
    schema_org: z
      .object({ '@context': z.string().trim().min(1), '@type': z.string().trim().min(1) })
      .catchall(z.unknown()),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
      .max(160),
  })
  .strict();

export const OfficialSiteContentSchema = z
  .object({
    blocks: z.array(BlockSchema).min(1),
    citation_map: z.array(CitationMapItemSchema),
    cta: z.string().max(200).nullable(),
    hashtags: z.array(z.string().max(40)).refine(unique),
    platform_code: z.literal(OFFICIAL_SITE_PLATFORM_CODE),
    platform_meta: OfficialSitePlatformMetaSchema,
    summary: z.string().max(240),
    title: unicodeText(2, 80),
  })
  .strict();

export const OfficialSiteCitationLinkSchema = z
  .object({
    citation_id: UuidSchema,
    label: z.string().trim().min(1).max(240),
    url: z.url().refine((value) => value.startsWith('https://') || value.startsWith('http://')),
  })
  .strict();

export const OfficialSiteRenderInputSchema = z
  .object({
    citations: z
      .array(OfficialSiteCitationLinkSchema)
      .max(200)
      .refine((items) => unique(items.map((item) => item.citation_id))),
    content: OfficialSiteContentSchema,
    rule_version: z.literal(OFFICIAL_SITE_RENDER_RULE_VERSION),
  })
  .strict();

export const OfficialSitePayloadSchema = z
  .object({
    citation_links: z.array(OfficialSiteCitationLinkSchema).max(200),
    faq: z.array(OfficialSiteFaqItemSchema).min(1).max(20),
    html: z.string().min(1),
    markdown: z.string().min(1),
    meta_description: z.string().trim().min(1).max(240),
    platform_code: z.literal(OFFICIAL_SITE_PLATFORM_CODE),
    rule_version: z.literal(OFFICIAL_SITE_RENDER_RULE_VERSION),
    schema_org: z
      .object({ '@context': z.string().trim().min(1), '@type': z.string().trim().min(1) })
      .catchall(z.unknown()),
    schema_version: z.literal(OFFICIAL_SITE_PAYLOAD_SCHEMA_VERSION),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
      .max(160),
    title: unicodeText(20, 60),
  })
  .strict();

export const OFFICIAL_SITE_RENDER_INPUT_JSON_SCHEMA = Object.freeze({
  $id: 'https://geo.example/schemas/official-site-render-input-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: {
    citations: {
      items: { $ref: '#/$defs/citation' },
      maxItems: 200,
      type: 'array',
    },
    content: { $ref: '#/$defs/content' },
    rule_version: { const: OFFICIAL_SITE_RENDER_RULE_VERSION },
  },
  required: ['rule_version', 'content', 'citations'],
  type: 'object',
  $defs: schemaDefinitions(),
});

export const OFFICIAL_SITE_PAYLOAD_JSON_SCHEMA = Object.freeze({
  $id: 'https://geo.example/schemas/official-site-payload-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: {
    citation_links: { items: { $ref: '#/$defs/citation' }, maxItems: 200, type: 'array' },
    faq: { items: { $ref: '#/$defs/faq' }, maxItems: 20, minItems: 1, type: 'array' },
    html: { minLength: 1, type: 'string' },
    markdown: { minLength: 1, type: 'string' },
    meta_description: { maxLength: 240, minLength: 1, type: 'string' },
    platform_code: { const: OFFICIAL_SITE_PLATFORM_CODE },
    rule_version: { const: OFFICIAL_SITE_RENDER_RULE_VERSION },
    schema_org: { $ref: '#/$defs/schema_org' },
    schema_version: { const: OFFICIAL_SITE_PAYLOAD_SCHEMA_VERSION },
    slug: { maxLength: 160, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', type: 'string' },
    title: { maxLength: 60, minLength: 20, type: 'string' },
  },
  required: [
    'schema_version',
    'rule_version',
    'platform_code',
    'slug',
    'title',
    'meta_description',
    'html',
    'markdown',
    'faq',
    'schema_org',
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
        platform_code: { const: OFFICIAL_SITE_PLATFORM_CODE },
        platform_meta: {
          additionalProperties: false,
          properties: {
            faq: { items: { $ref: '#/$defs/faq' }, maxItems: 20, minItems: 1, type: 'array' },
            meta_description: { maxLength: 240, minLength: 1, type: 'string' },
            schema_org: { $ref: '#/$defs/schema_org' },
            slug: { maxLength: 160, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', type: 'string' },
          },
          required: ['slug', 'meta_description', 'faq', 'schema_org'],
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
    faq: {
      additionalProperties: false,
      properties: {
        answer: { minLength: 1, type: 'string' },
        question: { minLength: 1, type: 'string' },
      },
      required: ['question', 'answer'],
      type: 'object',
    },
    schema_org: {
      properties: {
        '@context': { minLength: 1, type: 'string' },
        '@type': { minLength: 1, type: 'string' },
      },
      required: ['@context', '@type'],
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
