import { PLATFORM_CODES } from '../../platforms.js';
import type { PlatformCode } from '../../platforms.js';
import { createSkillResultSchema } from '../skill-result.schema.js';
import type { JsonSchema, SkillResult } from '../schema.types.js';

export const TOPIC_PLANNER_SKILL_NAME = 'topic-planner' as const;
export const TOPIC_PLANNER_SKILL_VERSION = '1.0.0' as const;
export const TOPIC_PLANNER_INPUT_SCHEMA_VERSION = 'topic-planner-input@1' as const;
export const TOPIC_PLANNER_DATA_SCHEMA_VERSION = 'topic-planner-data@1' as const;
export const TOPIC_PLANNER_OUTPUT_SCHEMA_VERSION = 'topic-planner-output@1' as const;

export const TOPIC_RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical'] as const);
export type TopicRiskLevel = (typeof TOPIC_RISK_LEVELS)[number];

const UUID_SCHEMA = Object.freeze({ format: 'uuid', type: 'string' });
const PLATFORM_LIST_SCHEMA = Object.freeze({
  items: { enum: PLATFORM_CODES },
  maxItems: PLATFORM_CODES.length,
  minItems: 1,
  type: 'array',
  uniqueItems: true,
});
const UNIQUE_UUID_LIST_SCHEMA = Object.freeze({
  items: UUID_SCHEMA,
  maxItems: 100,
  type: 'array',
  uniqueItems: true,
});

export const TOPIC_PLANNER_INPUT_SCHEMA: JsonSchema = Object.freeze({
  $id: 'https://geo.example/schemas/topic-planner-input-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: {
    keywords: {
      items: {
        additionalProperties: false,
        properties: {
          id: UUID_SCHEMA,
          intent: { enum: ['informational', 'commercial', 'transactional', 'navigational'] },
          platform_scope: PLATFORM_LIST_SCHEMA,
          priority: { maximum: 100, minimum: 0, type: 'integer' },
          synonyms: {
            items: { maxLength: 240, minLength: 1, type: 'string' },
            maxItems: 50,
            type: 'array',
            uniqueItems: true,
          },
          term: { maxLength: 240, minLength: 1, type: 'string' },
        },
        required: ['id', 'term', 'intent', 'priority', 'synonyms', 'platform_scope'],
        type: 'object',
      },
      minItems: 1,
      type: 'array',
    },
    metrics_summary: { type: 'object' },
    platform_scope: PLATFORM_LIST_SCHEMA,
    search_context: {
      additionalProperties: false,
      properties: {
        project_id: UUID_SCHEMA,
        seed_queries: {
          items: { maxLength: 240, minLength: 1, type: 'string' },
          maxItems: 20,
          type: 'array',
          uniqueItems: true,
        },
        top_k: { maximum: 20, minimum: 1, type: 'integer' },
        trust_levels: {
          items: { enum: ['verified', 'normal'] },
          minItems: 1,
          type: 'array',
          uniqueItems: true,
        },
        workspace_id: UUID_SCHEMA,
      },
      required: ['workspace_id', 'project_id', 'seed_queries', 'top_k', 'trust_levels'],
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
  required: ['strategy', 'keywords', 'metrics_summary', 'search_context', 'platform_scope'],
  type: 'object',
});

export const TOPIC_PLANNER_DATA_SCHEMA: JsonSchema = Object.freeze({
  $defs: {
    brief_suggestion: {
      additionalProperties: false,
      properties: {
        audience: { maxLength: 500, minLength: 10, type: 'string' },
        constraints: {
          additionalProperties: false,
          properties: {
            additional_instructions: { maxLength: 5000, minLength: 1, type: ['string', 'null'] },
            cta: { maxLength: 500, minLength: 1, type: ['string', 'null'] },
            schema_version: { const: 'brief-constraints@1', type: 'string' },
          },
          required: ['schema_version', 'additional_instructions', 'cta'],
          type: 'object',
        },
        due_at: { format: 'date-time', type: ['string', 'null'] },
        keyword_ids: {
          ...UNIQUE_UUID_LIST_SCHEMA,
          minItems: 1,
        },
        objective: { enum: ['awareness', 'conversion', 'trust', 'education'] },
        primary_keyword_id: UUID_SCHEMA,
        title: { maxLength: 80, minLength: 2, type: 'string' },
      },
      required: [
        'title',
        'objective',
        'audience',
        'primary_keyword_id',
        'keyword_ids',
        'due_at',
        'constraints',
      ],
      type: 'object',
    },
    topic: {
      additionalProperties: false,
      allOf: [
        {
          if: {
            properties: { evidence_ids: { maxItems: 0, type: 'array' } },
            required: ['evidence_ids'],
          },
          then: { properties: { risk_level: { enum: ['high', 'critical'] } } },
        },
      ],
      properties: {
        brief_suggestion: { $ref: '#/$defs/brief_suggestion' },
        entities: {
          items: { maxLength: 240, minLength: 1, type: 'string' },
          maxItems: 50,
          minItems: 1,
          type: 'array',
          uniqueItems: true,
        },
        evidence_ids: UNIQUE_UUID_LIST_SCHEMA,
        intent: { maxLength: 32, minLength: 1, type: 'string' },
        platform_codes: PLATFORM_LIST_SCHEMA,
        priority: { maximum: 100, minimum: 0, type: 'integer' },
        question: { maxLength: 2000, minLength: 5, type: 'string' },
        risk_level: { enum: TOPIC_RISK_LEVELS },
      },
      required: [
        'question',
        'intent',
        'entities',
        'evidence_ids',
        'platform_codes',
        'priority',
        'risk_level',
        'brief_suggestion',
      ],
      type: 'object',
    },
  },
  $id: 'https://geo.example/schemas/topic-planner-data-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: {
    topics: { items: { $ref: '#/$defs/topic' }, maxItems: 50, minItems: 1, type: 'array' },
  },
  required: ['topics'],
  type: 'object',
});

export const TOPIC_PLANNER_OUTPUT_SCHEMA = createSkillResultSchema(
  TOPIC_PLANNER_SKILL_NAME,
  TOPIC_PLANNER_DATA_SCHEMA,
  'https://geo.example/schemas/topic-planner-output-1.json',
);

export interface TopicBriefSuggestion {
  readonly audience: string;
  readonly constraints: {
    readonly additional_instructions: string | null;
    readonly cta: string | null;
    readonly schema_version: 'brief-constraints@1';
  };
  readonly due_at: string | null;
  readonly keyword_ids: readonly string[];
  readonly objective: 'awareness' | 'conversion' | 'education' | 'trust';
  readonly primary_keyword_id: string;
  readonly title: string;
}

export interface TopicPlannerTopic {
  readonly brief_suggestion: TopicBriefSuggestion;
  readonly entities: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly intent: string;
  readonly platform_codes: readonly PlatformCode[];
  readonly priority: number;
  readonly question: string;
  readonly risk_level: TopicRiskLevel;
}

export interface TopicPlannerData {
  readonly topics: readonly TopicPlannerTopic[];
}

export type TopicPlannerOutput = SkillResult<TopicPlannerData, 'topic-planner'>;
