import { PLATFORM_CODES } from '../../platforms.js';
import type { PlatformCode } from '../../platforms.js';
import { createSkillResultSchema } from '../skill-result.schema.js';
import type { JsonSchema, SkillResult } from '../schema.types.js';

export const GEO_OPTIMIZER_SKILL_NAME = 'geo-optimizer' as const;
export const GEO_OPTIMIZER_SKILL_VERSION = '1.0.0' as const;
export const GEO_OPTIMIZER_INPUT_SCHEMA_VERSION = 'geo-optimizer-input@1' as const;
export const GEO_OPTIMIZER_DATA_SCHEMA_VERSION = 'geo-optimizer-data@1' as const;
export const GEO_OPTIMIZER_OUTPUT_SCHEMA_VERSION = 'geo-optimizer-output@1' as const;

export const GEO_REWRITE_OPERATIONS = Object.freeze([
  'keep',
  'rewrite',
  'move',
  'split',
  'add',
] as const);
export type GeoRewriteOperation = (typeof GEO_REWRITE_OPERATIONS)[number];

const UUID_SCHEMA = Object.freeze({ format: 'uuid', type: 'string' });
const HASH_SCHEMA = Object.freeze({ pattern: '^[a-f0-9]{64}$', type: 'string' });
const BLOCK_KEY_SCHEMA = Object.freeze({ pattern: '^[a-z0-9_-]{1,80}$', type: 'string' });
const CONTENT_SCHEMA = Object.freeze({
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
      if: { properties: { platform_code: { const: 'toutiao' } } },
      then: { properties: { title: { maxLength: 50, type: 'string' } } },
    },
    {
      if: { properties: { platform_code: { const: 'xiaohongshu' } } },
      then: { properties: { title: { maxLength: 20, type: 'string' } } },
    },
    {
      if: { properties: { platform_code: { const: 'wechat_mp' } } },
      then: { properties: { title: { maxLength: 64, type: 'string' } } },
    },
  ],
  properties: {
    blocks: {
      items: {
        additionalProperties: false,
        properties: {
          block_key: BLOCK_KEY_SCHEMA,
          block_type: { enum: ['heading', 'paragraph', 'list', 'quote', 'media', 'cta'] },
          text: { type: 'string' },
        },
        required: ['block_key', 'block_type', 'text'],
        type: 'object',
      },
      minItems: 1,
      type: 'array',
    },
    citation_map: {
      items: {
        additionalProperties: false,
        properties: {
          citation_ids: { items: UUID_SCHEMA, type: 'array', uniqueItems: true },
          claim_key: { minLength: 1, type: 'string' },
          claim_text: { minLength: 1, type: 'string' },
        },
        required: ['claim_key', 'claim_text', 'citation_ids'],
        type: 'object',
      },
      type: 'array',
    },
    cta: { maxLength: 200, type: ['string', 'null'] },
    hashtags: {
      items: { maxLength: 40, type: 'string' },
      type: 'array',
      uniqueItems: true,
    },
    platform_code: { enum: PLATFORM_CODES },
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
});

export const GEO_OPTIMIZER_INPUT_SCHEMA: JsonSchema = Object.freeze({
  $id: 'https://geo.example/schemas/geo-optimizer-input-1.json',
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
        questions: {
          items: { minLength: 1, type: 'string' },
          minItems: 1,
          type: 'array',
          uniqueItems: true,
        },
      },
      required: ['brief_id', 'objective', 'audience', 'questions', 'constraints'],
      type: 'object',
    },
    citations: {
      items: {
        additionalProperties: false,
        properties: {
          chunk_id: UUID_SCHEMA,
          citation_id: UUID_SCHEMA,
          claim_key: { minLength: 1, type: 'string' },
          claim_text: { minLength: 1, type: 'string' },
          quote_text: { minLength: 1, type: 'string' },
          source_id: UUID_SCHEMA,
        },
        required: ['citation_id', 'source_id', 'chunk_id', 'claim_key', 'claim_text', 'quote_text'],
        type: 'object',
      },
      type: 'array',
    },
    content_version: {
      additionalProperties: false,
      properties: {
        content: CONTENT_SCHEMA,
        content_hash: HASH_SCHEMA,
        content_version_id: UUID_SCHEMA,
        variant_id: UUID_SCHEMA,
      },
      required: ['content_version_id', 'variant_id', 'content_hash', 'content'],
      type: 'object',
    },
    locked_blocks: {
      items: {
        additionalProperties: false,
        properties: {
          block_key: BLOCK_KEY_SCHEMA,
          citation_ids: { items: UUID_SCHEMA, type: 'array', uniqueItems: true },
          text: { type: 'string' },
        },
        required: ['block_key', 'text', 'citation_ids'],
        type: 'object',
      },
      type: 'array',
    },
    platform_rules: {
      additionalProperties: false,
      properties: {
        platform_code: { enum: PLATFORM_CODES },
        rules: { type: 'object' },
        rules_hash: HASH_SCHEMA,
        version_id: UUID_SCHEMA,
      },
      required: ['platform_code', 'version_id', 'rules_hash', 'rules'],
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
    'content_version',
    'brief',
    'strategy',
    'citations',
    'platform_rules',
    'locked_blocks',
  ],
  type: 'object',
});

const SCORE_SCHEMA = Object.freeze({ maximum: 100, minimum: 0, type: 'number' });

export const GEO_OPTIMIZER_DATA_SCHEMA: JsonSchema = Object.freeze({
  $id: 'https://geo.example/schemas/geo-optimizer-data-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: {
    optimized_content: CONTENT_SCHEMA,
    rewrite_plan: {
      items: {
        additionalProperties: false,
        properties: {
          block_key: BLOCK_KEY_SCHEMA,
          must_preserve_citations: { type: 'boolean' },
          operation: { enum: GEO_REWRITE_OPERATIONS },
          reason: { minLength: 1, type: 'string' },
        },
        required: ['block_key', 'reason', 'operation', 'must_preserve_citations'],
        type: 'object',
      },
      type: 'array',
    },
    scores: {
      additionalProperties: false,
      properties: {
        answerability: SCORE_SCHEMA,
        entity: SCORE_SCHEMA,
        evidence: SCORE_SCHEMA,
        platform_fit: SCORE_SCHEMA,
        question: SCORE_SCHEMA,
        readability_safety: SCORE_SCHEMA,
        total: SCORE_SCHEMA,
      },
      required: [
        'entity',
        'question',
        'answerability',
        'evidence',
        'platform_fit',
        'readability_safety',
        'total',
      ],
      type: 'object',
    },
  },
  required: ['scores', 'rewrite_plan', 'optimized_content'],
  type: 'object',
});

export const GEO_OPTIMIZER_OUTPUT_SCHEMA = createSkillResultSchema(
  GEO_OPTIMIZER_SKILL_NAME,
  GEO_OPTIMIZER_DATA_SCHEMA,
  'https://geo.example/schemas/geo-optimizer-output-1.json',
);

export interface GeoScoreSet {
  readonly answerability: number;
  readonly entity: number;
  readonly evidence: number;
  readonly platform_fit: number;
  readonly question: number;
  readonly readability_safety: number;
  readonly total: number;
}

export interface GeoRewritePlanItem {
  readonly block_key: string;
  readonly must_preserve_citations: boolean;
  readonly operation: GeoRewriteOperation;
  readonly reason: string;
}

export interface GeoOptimizedContent {
  readonly blocks: readonly {
    readonly block_key: string;
    readonly block_type: 'cta' | 'heading' | 'list' | 'media' | 'paragraph' | 'quote';
    readonly text: string;
  }[];
  readonly citation_map: readonly {
    readonly citation_ids: readonly string[];
    readonly claim_key: string;
    readonly claim_text: string;
  }[];
  readonly cta: string | null;
  readonly hashtags: readonly string[];
  readonly platform_code: PlatformCode;
  readonly platform_meta: Readonly<Record<string, unknown>>;
  readonly summary: string;
  readonly title: string;
}

export interface GeoOptimizerData {
  readonly optimized_content: GeoOptimizedContent;
  readonly rewrite_plan: readonly GeoRewritePlanItem[];
  readonly scores: GeoScoreSet;
}

export type GeoOptimizerOutput = SkillResult<GeoOptimizerData, 'geo-optimizer'>;
