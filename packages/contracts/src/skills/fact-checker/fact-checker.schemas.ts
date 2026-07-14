import { createSkillResultSchema } from '../skill-result.schema.js';
import type { JsonSchema, SkillResult } from '../schema.types.js';

export const FACT_CHECKER_SKILL_NAME = 'fact-checker' as const;
export const FACT_CHECKER_SKILL_VERSION = '1.0.0' as const;
export const FACT_CHECKER_INPUT_SCHEMA_VERSION = 'fact-checker-input@1' as const;
export const FACT_CHECKER_DATA_SCHEMA_VERSION = 'fact-checker-data@1' as const;
export const FACT_CHECKER_OUTPUT_SCHEMA_VERSION = 'fact-checker-output@1' as const;

export const FACT_VERDICTS = Object.freeze([
  'supported',
  'partially_supported',
  'conflicted',
  'unsupported',
  'outdated',
] as const);
export const FACT_RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical'] as const);

export type FactVerdict = (typeof FACT_VERDICTS)[number];
export type FactRiskLevel = (typeof FACT_RISK_LEVELS)[number];

const UUID_SCHEMA = Object.freeze({ format: 'uuid', type: 'string' });
const HASH_SCHEMA = Object.freeze({ pattern: '^[a-f0-9]{64}$', type: 'string' });

export const FACT_CHECKER_INPUT_SCHEMA: JsonSchema = Object.freeze({
  $id: 'https://geo.example/schemas/fact-checker-input-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: {
    claims: {
      items: {
        additionalProperties: false,
        properties: {
          claim_key: { maxLength: 80, minLength: 1, type: 'string' },
          claim_text: { minLength: 1, type: 'string' },
          risk_level: { enum: FACT_RISK_LEVELS },
        },
        required: ['claim_key', 'claim_text', 'risk_level'],
        type: 'object',
      },
      minItems: 1,
      type: 'array',
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
    risk_policy: {
      additionalProperties: false,
      properties: {
        human_review_levels: {
          items: { enum: ['high', 'critical'] },
          type: 'array',
          uniqueItems: true,
        },
        require_verified_for_high_risk: { type: 'boolean' },
      },
      required: ['require_verified_for_high_risk', 'human_review_levels'],
      type: 'object',
    },
    search_policy: {
      additionalProperties: false,
      properties: {
        top_k: { maximum: 20, minimum: 1, type: 'integer' },
        trust_levels: {
          items: { enum: ['verified', 'normal'] },
          minItems: 1,
          type: 'array',
          uniqueItems: true,
        },
      },
      required: ['top_k', 'trust_levels'],
      type: 'object',
    },
  },
  required: ['content_version', 'claims', 'search_policy', 'risk_policy'],
  type: 'object',
});

export const FACT_CHECKER_DATA_SCHEMA: JsonSchema = Object.freeze({
  $id: 'https://geo.example/schemas/fact-checker-data-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: {
    overall_decision: { enum: ['pass', 'revise', 'block'] },
    results: {
      items: {
        additionalProperties: false,
        allOf: [
          {
            if: { properties: { verdict: { const: 'unsupported' } }, required: ['verdict'] },
            then: { properties: { evidences: { maxItems: 0, type: 'array' } } },
          },
          {
            if: {
              properties: {
                verdict: {
                  enum: ['supported', 'partially_supported', 'conflicted', 'outdated'],
                },
              },
              required: ['verdict'],
            },
            then: { properties: { evidences: { minItems: 1, type: 'array' } } },
          },
        ],
        properties: {
          claim_key: { type: 'string' },
          claim_text: { minLength: 1, type: 'string' },
          confidence: { maximum: 1, minimum: 0, type: 'number' },
          evidences: {
            items: {
              additionalProperties: false,
              properties: {
                chunk_id: UUID_SCHEMA,
                confidence: { maximum: 1, minimum: 0, type: 'number' },
                quote_text: { minLength: 1, type: 'string' },
                support_level: {
                  enum: ['supported', 'partially_supported', 'conflicted', 'outdated'],
                },
              },
              required: ['chunk_id', 'quote_text', 'support_level', 'confidence'],
              type: 'object',
            },
            type: 'array',
          },
          reason: { minLength: 1, type: 'string' },
          rewrite_suggestion: { type: ['string', 'null'] },
          risk_level: { enum: FACT_RISK_LEVELS },
          verdict: { enum: FACT_VERDICTS },
        },
        required: [
          'claim_key',
          'claim_text',
          'verdict',
          'risk_level',
          'confidence',
          'reason',
          'rewrite_suggestion',
          'evidences',
        ],
        type: 'object',
      },
      type: 'array',
    },
  },
  required: ['results', 'overall_decision'],
  type: 'object',
});

export const FACT_CHECKER_OUTPUT_SCHEMA = createSkillResultSchema(
  FACT_CHECKER_SKILL_NAME,
  FACT_CHECKER_DATA_SCHEMA,
  'https://geo.example/schemas/fact-checker-output-1.json',
);

export interface FactEvidence {
  readonly chunk_id: string;
  readonly confidence: number;
  readonly quote_text: string;
  readonly support_level: Exclude<FactVerdict, 'unsupported'>;
}

export interface FactCheckResult {
  readonly claim_key: string;
  readonly claim_text: string;
  readonly confidence: number;
  readonly evidences: readonly FactEvidence[];
  readonly reason: string;
  readonly rewrite_suggestion: string | null;
  readonly risk_level: FactRiskLevel;
  readonly verdict: FactVerdict;
}

export interface FactCheckerData {
  readonly overall_decision: 'block' | 'pass' | 'revise';
  readonly results: readonly FactCheckResult[];
}

export type FactCheckerOutput = SkillResult<FactCheckerData, 'fact-checker'>;
