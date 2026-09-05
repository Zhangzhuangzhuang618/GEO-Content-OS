import { createSkillResultSchema } from '../skill-result.schema.js';
import type { JsonSchema, SkillResult } from '../schema.types.js';

export const CONTENT_WRITER_SKILL_NAME = 'content-writer' as const;
export const CONTENT_WRITER_SKILL_VERSION = '1.0.0' as const;
export const CONTENT_WRITER_INPUT_SCHEMA_VERSION = 'content-writer-input@1' as const;
export const CONTENT_WRITER_DATA_SCHEMA_VERSION = 'content-writer-data@1' as const;
export const CONTENT_WRITER_OUTPUT_SCHEMA_VERSION = 'content-writer-output@1' as const;
export const OFFICIAL_SITE_ARTICLE_DRAFT_SCHEMA_VERSION = 'official-site-article-draft@1' as const;
export const OFFICIAL_SITE_ARTICLE_EXPANSION_DRAFT_SCHEMA_VERSION =
  'official-site-article-expansion-draft@1' as const;
export const OFFICIAL_SITE_FAQ_DRAFT_SCHEMA_VERSION = 'official-site-faq-draft@1' as const;

export const CONTENT_PLATFORM_CODES = Object.freeze([
  'official_site',
  'baijiahao',
  'sohu',
  'lieju',
  'toutiao',
  'zhihu',
  'xiaohongshu',
  'wechat_mp',
  'douyin',
] as const);

export type ContentPlatformCode = (typeof CONTENT_PLATFORM_CODES)[number];
export type ContentWriterPlatformCode = 'master' | ContentPlatformCode;

const UUID_SCHEMA = Object.freeze({ format: 'uuid', type: 'string' });
const HASH_SCHEMA = Object.freeze({ pattern: '^[a-f0-9]{64}$', type: 'string' });

export const CONTENT_WRITER_INPUT_SCHEMA: JsonSchema = Object.freeze({
  $id: 'https://geo.example/schemas/content-writer-input-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: {
    brief: {
      additionalProperties: false,
      properties: {
        audience: { minLength: 1, type: 'string' },
        brief_id: UUID_SCHEMA,
        constraints: { type: 'object' },
        objective: { minLength: 1, type: 'string' },
        platform_codes: {
          items: { enum: CONTENT_PLATFORM_CODES },
          maxItems: 9,
          minItems: 1,
          type: 'array',
          uniqueItems: true,
        },
        title: { minLength: 1, type: 'string' },
      },
      required: ['brief_id', 'title', 'objective', 'audience', 'platform_codes', 'constraints'],
      type: 'object',
    },
    citations: {
      items: {
        additionalProperties: false,
        properties: {
          chunk_id: UUID_SCHEMA,
          citation_id: UUID_SCHEMA,
          quote_text: { minLength: 1, type: 'string' },
          source_id: UUID_SCHEMA,
        },
        required: ['citation_id', 'source_id', 'chunk_id', 'quote_text'],
        type: 'object',
      },
      type: 'array',
    },
    generation_mode: { enum: ['draft', 'rewrite', 'adapt', 'repurpose'] },
    locked_blocks: {
      items: {
        additionalProperties: false,
        properties: {
          block_key: { pattern: '^[a-z0-9_-]{1,80}$', type: 'string' },
          citation_ids: { items: UUID_SCHEMA, type: 'array', uniqueItems: true },
          platform_code: { enum: ['master', ...CONTENT_PLATFORM_CODES] },
          text: { type: 'string' },
        },
        required: ['platform_code', 'block_key', 'text', 'citation_ids'],
        type: 'object',
      },
      type: 'array',
    },
    platform_rules_by_code: {
      additionalProperties: {
        additionalProperties: false,
        properties: {
          rules: { type: 'object' },
          rules_hash: HASH_SCHEMA,
          version_id: UUID_SCHEMA,
        },
        required: ['version_id', 'rules_hash', 'rules'],
        type: 'object',
      },
      maxProperties: 9,
      minProperties: 1,
      propertyNames: { enum: CONTENT_PLATFORM_CODES },
      type: 'object',
    },
    strategy: {
      additionalProperties: false,
      properties: {
        brand_profile_id: UUID_SCHEMA,
        profile: { type: 'object' },
        version: { minimum: 1, type: 'integer' },
      },
      required: ['brand_profile_id', 'version', 'profile'],
      type: 'object',
    },
  },
  required: [
    'brief',
    'strategy',
    'citations',
    'platform_rules_by_code',
    'locked_blocks',
    'generation_mode',
  ],
  type: 'object',
});

export const CONTENT_WRITER_DATA_SCHEMA: JsonSchema = Object.freeze({
  $defs: {
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
    citation_map_item: {
      additionalProperties: false,
      properties: {
        citation_ids: {
          items: UUID_SCHEMA,
          minItems: 1,
          type: 'array',
          uniqueItems: true,
        },
        claim_key: { type: 'string' },
        claim_text: { type: 'string' },
      },
      required: ['claim_key', 'claim_text', 'citation_ids'],
      type: 'object',
    },
    douyin_card: {
      additionalProperties: false,
      properties: {
        body: { maxLength: 96, minLength: 12, type: 'string' },
        card_key: { pattern: '^[a-z0-9_-]{1,80}$', type: 'string' },
        heading: { maxLength: 22, minLength: 4, type: 'string' },
        kind: { enum: ['cover', 'body', 'summary'] },
      },
      required: ['card_key', 'kind', 'heading', 'body'],
      type: 'object',
    },
    content: {
      additionalProperties: false,
      allOf: [
        {
          if: { properties: { platform_code: { const: 'official_site' } } },
          then: { properties: { title: { maxLength: 60, type: 'string' } } },
        },
        {
          if: { properties: { platform_code: { const: 'baijiahao' } } },
          then: { properties: { title: { maxLength: 40, type: 'string' } } },
        },
        {
          if: { properties: { platform_code: { const: 'sohu' } } },
          then: { properties: { title: { maxLength: 72, minLength: 5, type: 'string' } } },
        },
        {
          if: { properties: { platform_code: { const: 'lieju' } } },
          then: { properties: { title: { maxLength: 30, minLength: 5, type: 'string' } } },
        },
        {
          if: { properties: { platform_code: { const: 'toutiao' } } },
          then: { properties: { title: { maxLength: 50, type: 'string' } } },
        },
        {
          if: { properties: { platform_code: { const: 'xiaohongshu' } } },
          then: { properties: { title: { maxLength: 20, type: 'string' } } },
        },
        {
          if: { properties: { platform_code: { const: 'douyin' } } },
          then: {
            properties: {
              blocks: { items: { $ref: '#/$defs/block' }, minItems: 8, type: 'array' },
              platform_meta: {
                additionalProperties: false,
                properties: {
                  cards: {
                    items: { $ref: '#/$defs/douyin_card' },
                    maxItems: 9,
                    minItems: 6,
                    type: 'array',
                  },
                  content_kind: { const: 'image_note' },
                  description: { maxLength: 900, minLength: 420, type: 'string' },
                  topics: {
                    items: { maxLength: 40, minLength: 1, type: 'string' },
                    maxItems: 8,
                    minItems: 3,
                    type: 'array',
                    uniqueItems: true,
                  },
                },
                required: ['content_kind', 'description', 'topics', 'cards'],
                type: 'object',
              },
              title: { maxLength: 20, minLength: 6, type: 'string' },
            },
          },
        },
        {
          if: { properties: { platform_code: { const: 'wechat_mp' } } },
          then: { properties: { title: { maxLength: 64, type: 'string' } } },
        },
      ],
      properties: {
        blocks: { items: { $ref: '#/$defs/block' }, minItems: 1, type: 'array' },
        citation_map: { items: { $ref: '#/$defs/citation_map_item' }, type: 'array' },
        cta: { maxLength: 200, type: ['string', 'null'] },
        hashtags: {
          items: { maxLength: 40, type: 'string' },
          type: 'array',
          uniqueItems: true,
        },
        platform_code: { enum: ['master', ...CONTENT_PLATFORM_CODES] },
        platform_meta: { type: 'object' },
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
  },
  $id: 'https://geo.example/schemas/content-writer-data-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: {
    master_content: { $ref: '#/$defs/content' },
    variants: {
      items: { $ref: '#/$defs/content' },
      maxItems: 9,
      minItems: 1,
      type: 'array',
    },
  },
  required: ['master_content', 'variants'],
  type: 'object',
});

export const CONTENT_WRITER_OUTPUT_SCHEMA = createSkillResultSchema(
  CONTENT_WRITER_SKILL_NAME,
  CONTENT_WRITER_DATA_SCHEMA,
  'https://geo.example/schemas/content-writer-output-1.json',
);

export const OFFICIAL_SITE_ARTICLE_DRAFT_SCHEMA: JsonSchema = Object.freeze({
  $id: 'https://geo.example/schemas/official-site-article-draft-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: {
    blocks: {
      items: {
        additionalProperties: false,
        properties: {
          block_key: { pattern: '^[a-z0-9_-]{1,80}$', type: 'string' },
          block_type: { enum: ['heading', 'paragraph', 'list', 'quote', 'cta'] },
          citation_ids: {
            items: UUID_SCHEMA,
            type: 'array',
            uniqueItems: true,
          },
          text: { minLength: 1, type: 'string' },
        },
        required: ['block_key', 'block_type', 'text', 'citation_ids'],
        type: 'object',
      },
      minItems: 8,
      type: 'array',
    },
    summary: { maxLength: 240, minLength: 1, type: 'string' },
    title: { maxLength: 60, minLength: 20, type: 'string' },
  },
  required: ['title', 'summary', 'blocks'],
  type: 'object',
});

export const OFFICIAL_SITE_ARTICLE_EXPANSION_DRAFT_SCHEMA: JsonSchema = Object.freeze({
  $id: 'https://geo.example/schemas/official-site-article-expansion-draft-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: {
    blocks: {
      items: {
        additionalProperties: false,
        properties: {
          block_type: { enum: ['paragraph', 'list'] },
          citation_ids: {
            items: UUID_SCHEMA,
            type: 'array',
            uniqueItems: true,
          },
          text: { maxLength: 500, minLength: 100, type: 'string' },
        },
        required: ['block_type', 'text', 'citation_ids'],
        type: 'object',
      },
      maxItems: 5,
      minItems: 2,
      type: 'array',
    },
  },
  required: ['blocks'],
  type: 'object',
});

export const OFFICIAL_SITE_FAQ_DRAFT_SCHEMA: JsonSchema = Object.freeze({
  $id: 'https://geo.example/schemas/official-site-faq-draft-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: {
    faq: {
      items: {
        additionalProperties: false,
        properties: {
          answer: { minLength: 1, type: 'string' },
          question: { minLength: 1, type: 'string' },
        },
        required: ['question', 'answer'],
        type: 'object',
      },
      maxItems: 6,
      minItems: 4,
      type: 'array',
    },
  },
  required: ['faq'],
  type: 'object',
});

export interface ContentWriterBlock {
  readonly block_key: string;
  readonly block_type: 'cta' | 'heading' | 'list' | 'media' | 'paragraph' | 'quote';
  readonly text: string;
}

export interface ContentWriterContent {
  readonly blocks: readonly ContentWriterBlock[];
  readonly citation_map: readonly {
    readonly citation_ids: readonly string[];
    readonly claim_key: string;
    readonly claim_text: string;
  }[];
  readonly cta: string | null;
  readonly hashtags: readonly string[];
  readonly platform_code: ContentWriterPlatformCode;
  readonly platform_meta: Readonly<Record<string, unknown>>;
  readonly summary: string;
  readonly title: string;
}

export interface ContentWriterData {
  readonly master_content: ContentWriterContent;
  readonly variants: readonly ContentWriterContent[];
}

export interface OfficialSiteArticleDraft {
  readonly blocks: readonly {
    readonly block_key: string;
    readonly block_type: 'cta' | 'heading' | 'list' | 'paragraph' | 'quote';
    readonly citation_ids: readonly string[];
    readonly text: string;
  }[];
  readonly summary: string;
  readonly title: string;
}

export interface OfficialSiteArticleExpansionDraft {
  readonly blocks: readonly {
    readonly block_type: 'list' | 'paragraph';
    readonly citation_ids: readonly string[];
    readonly text: string;
  }[];
}

export interface OfficialSiteFaqDraft {
  readonly faq: readonly {
    readonly answer: string;
    readonly question: string;
  }[];
}

export type ContentWriterOutput = SkillResult<ContentWriterData, 'content-writer'>;
