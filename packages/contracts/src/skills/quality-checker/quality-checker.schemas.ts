import { PLATFORM_CODES } from '../../platforms.js';
import { createSkillResultSchema } from '../skill-result.schema.js';
import type { JsonSchema, SkillResult } from '../schema.types.js';

export const QUALITY_CHECKER_SKILL_NAME = 'quality-checker' as const;
export const QUALITY_CHECKER_SKILL_VERSION = '1.0.0' as const;
export const QUALITY_CHECKER_INPUT_SCHEMA_VERSION = 'quality-checker-input@1' as const;
export const QUALITY_CHECKER_DATA_SCHEMA_VERSION = 'quality-checker-data@1' as const;
export const QUALITY_CHECKER_OUTPUT_SCHEMA_VERSION = 'quality-checker-output@1' as const;

export const QUALITY_CATEGORIES = Object.freeze([
  'fact',
  'brand',
  'compliance',
  'format',
  'duplicate',
  'readability',
  'security',
] as const);
export const QUALITY_SEVERITIES = Object.freeze(['BLOCK', 'WARN', 'INFO'] as const);
export const QUALITY_DECISIONS = Object.freeze(['pass', 'revise', 'block'] as const);

export type QualityCategory = (typeof QUALITY_CATEGORIES)[number];
export type QualitySeverity = (typeof QUALITY_SEVERITIES)[number];
export type QualityDecision = (typeof QUALITY_DECISIONS)[number];

const UUID_SCHEMA = Object.freeze({ format: 'uuid', type: 'string' });
const HASH_SCHEMA = Object.freeze({ pattern: '^[a-f0-9]{64}$', type: 'string' });
const SCORE_SCHEMA = Object.freeze({ maximum: 100, minimum: 0, type: 'number' });
const GEO_SCORES_SCHEMA = Object.freeze({
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
});

export const QUALITY_CHECKER_INPUT_SCHEMA: JsonSchema = Object.freeze({
  $id: 'https://geo.example/schemas/quality-checker-input-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: {
    brand_policy: {
      additionalProperties: false,
      properties: {
        brand_profile_id: UUID_SCHEMA,
        policy: { type: 'object' },
        version: { minimum: 1, type: 'integer' },
      },
      required: ['brand_profile_id', 'version', 'policy'],
      type: 'object',
    },
    content_version: {
      additionalProperties: false,
      properties: {
        content: { type: 'object' },
        content_hash: HASH_SCHEMA,
        content_version_id: UUID_SCHEMA,
        variant_id: UUID_SCHEMA,
      },
      required: ['content_version_id', 'variant_id', 'content_hash', 'content'],
      type: 'object',
    },
    duplicate_matches: {
      items: {
        additionalProperties: false,
        properties: {
          content_version_id: UUID_SCHEMA,
          excerpt: { type: ['string', 'null'] },
          similarity: { maximum: 1, minimum: 0, type: 'number' },
        },
        required: ['content_version_id', 'similarity', 'excerpt'],
        type: 'object',
      },
      type: 'array',
    },
    fact_results: {
      items: {
        additionalProperties: false,
        properties: {
          citation_ids: { items: UUID_SCHEMA, type: 'array', uniqueItems: true },
          claim_key: { minLength: 1, type: 'string' },
          claim_text: { minLength: 1, type: 'string' },
          confidence: { maximum: 1, minimum: 0, type: 'number' },
          risk_level: { enum: ['low', 'medium', 'high', 'critical'] },
          verdict: {
            enum: ['supported', 'partially_supported', 'conflicted', 'unsupported', 'outdated'],
          },
        },
        required: [
          'claim_key',
          'claim_text',
          'verdict',
          'risk_level',
          'confidence',
          'citation_ids',
        ],
        type: 'object',
      },
      type: 'array',
    },
    geo_result: {
      additionalProperties: false,
      properties: { scores: GEO_SCORES_SCHEMA },
      required: ['scores'],
      type: 'object',
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
    safety_policy: {
      additionalProperties: false,
      properties: {
        block_on_data_leakage: { type: 'boolean' },
        block_on_injection: { type: 'boolean' },
        max_warnings_for_pass: { minimum: 0, type: 'integer' },
      },
      required: ['max_warnings_for_pass', 'block_on_injection', 'block_on_data_leakage'],
      type: 'object',
    },
  },
  required: [
    'content_version',
    'fact_results',
    'geo_result',
    'brand_policy',
    'platform_rules',
    'duplicate_matches',
    'safety_policy',
  ],
  type: 'object',
});

const ISSUE_SCHEMA = Object.freeze({
  additionalProperties: false,
  properties: {
    category: { enum: QUALITY_CATEGORIES },
    citation_ids: { items: UUID_SCHEMA, type: 'array', uniqueItems: true },
    location: { type: ['string', 'null'] },
    message: { minLength: 1, type: 'string' },
    rule_id: { minLength: 1, type: 'string' },
    severity: { enum: QUALITY_SEVERITIES },
    suggestion: { type: ['string', 'null'] },
  },
  required: [
    'rule_id',
    'category',
    'severity',
    'location',
    'message',
    'suggestion',
    'citation_ids',
  ],
  type: 'object',
});

export const QUALITY_CHECKER_DATA_SCHEMA: JsonSchema = Object.freeze({
  $id: 'https://geo.example/schemas/quality-checker-data-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  allOf: [
    {
      if: { properties: { decision: { const: 'block' } }, required: ['decision'] },
      then: {
        properties: {
          issues: {
            contains: {
              properties: { severity: { const: 'BLOCK' } },
              required: ['severity'],
              type: 'object',
            },
            minContains: 1,
            type: 'array',
          },
        },
      },
    },
    {
      if: { properties: { decision: { enum: ['pass', 'revise'] } }, required: ['decision'] },
      then: {
        properties: {
          issues: {
            not: {
              contains: {
                properties: { severity: { const: 'BLOCK' } },
                required: ['severity'],
                type: 'object',
              },
            },
            type: 'array',
          },
        },
      },
    },
    {
      if: { properties: { decision: { const: 'revise' } }, required: ['decision'] },
      then: {
        properties: {
          issues: {
            contains: {
              properties: { severity: { const: 'WARN' } },
              required: ['severity'],
              type: 'object',
            },
            minContains: 1,
            type: 'array',
          },
        },
      },
    },
  ],
  properties: {
    decision: { enum: QUALITY_DECISIONS },
    geo_scores: GEO_SCORES_SCHEMA,
    issues: { items: ISSUE_SCHEMA, type: 'array' },
    score: SCORE_SCHEMA,
  },
  required: ['score', 'decision', 'issues', 'geo_scores'],
  type: 'object',
});

export const QUALITY_CHECKER_OUTPUT_SCHEMA = createSkillResultSchema(
  QUALITY_CHECKER_SKILL_NAME,
  QUALITY_CHECKER_DATA_SCHEMA,
  'https://geo.example/schemas/quality-checker-output-1.json',
);

export interface QualityIssue {
  readonly category: QualityCategory;
  readonly citation_ids: readonly string[];
  readonly location: string | null;
  readonly message: string;
  readonly rule_id: string;
  readonly severity: QualitySeverity;
  readonly suggestion: string | null;
}

export interface QualityGeoScores {
  readonly answerability: number;
  readonly entity: number;
  readonly evidence: number;
  readonly platform_fit: number;
  readonly question: number;
  readonly readability_safety: number;
  readonly total: number;
}

export interface QualityCheckerData {
  readonly decision: QualityDecision;
  readonly geo_scores: QualityGeoScores;
  readonly issues: readonly QualityIssue[];
  readonly score: number;
}

export type QualityCheckerOutput = SkillResult<QualityCheckerData, 'quality-checker'>;
