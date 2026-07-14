import { createSkillResultSchema } from '../skill-result.schema.js';
import type { JsonSchema, SkillResult } from '../schema.types.js';

export const MATERIAL_PARSER_SKILL_NAME = 'material-parser' as const;
export const MATERIAL_PARSER_SKILL_VERSION = '1.0.0' as const;
export const MATERIAL_PARSER_INPUT_SCHEMA_VERSION = 'material-parser-input@1' as const;
export const MATERIAL_PARSER_DATA_SCHEMA_VERSION = 'material-parser-data@1' as const;
export const MATERIAL_PARSER_OUTPUT_SCHEMA_VERSION = 'material-parser-output@1' as const;

const HASH_SCHEMA = Object.freeze({ pattern: '^[a-f0-9]{64}$', type: 'string' });
const NULLABLE_PAGE_SCHEMA = Object.freeze({ minimum: 1, type: ['integer', 'null'] });
const NULLABLE_URL_SCHEMA = Object.freeze({ format: 'uri', type: ['string', 'null'] });

export const MATERIAL_PARSER_INPUT_SCHEMA: JsonSchema = Object.freeze({
  $id: 'https://geo.example/schemas/material-parser-input-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: {
    document_metadata: {
      additionalProperties: false,
      properties: {
        content_hash: HASH_SCHEMA,
        language: { minLength: 2, type: 'string' },
        mime_type: { minLength: 3, type: 'string' },
        source_document_id: { format: 'uuid', type: 'string' },
        source_type: { enum: ['docx', 'image', 'pdf', 'txt', 'url'] },
        title: { maxLength: 240, minLength: 1, type: 'string' },
      },
      required: [
        'source_document_id',
        'title',
        'language',
        'mime_type',
        'source_type',
        'content_hash',
      ],
      type: 'object',
    },
    extracted_text: { minLength: 1, type: 'string' },
    page_map: {
      items: {
        additionalProperties: false,
        properties: {
          char_end: { minimum: 1, type: 'integer' },
          char_start: { minimum: 0, type: 'integer' },
          page: NULLABLE_PAGE_SCHEMA,
          url: NULLABLE_URL_SCHEMA,
        },
        required: ['page', 'url', 'char_start', 'char_end'],
        type: 'object',
      },
      minItems: 1,
      type: 'array',
    },
    parser_policy: {
      additionalProperties: false,
      properties: {
        max_tokens: { const: 900, type: 'integer' },
        min_tokens: { const: 500, type: 'integer' },
        overlap_tokens: { const: 80, type: 'integer' },
        target_tokens: { maximum: 900, minimum: 500, type: 'integer' },
      },
      required: ['min_tokens', 'target_tokens', 'max_tokens', 'overlap_tokens'],
      type: 'object',
    },
  },
  required: ['document_metadata', 'extracted_text', 'page_map', 'parser_policy'],
  type: 'object',
});

export const MATERIAL_PARSER_DATA_SCHEMA: JsonSchema = Object.freeze({
  $id: 'https://geo.example/schemas/material-parser-data-1.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: {
    candidate_facts: {
      items: {
        additionalProperties: false,
        properties: {
          confidence: { maximum: 1, minimum: 0, type: 'number' },
          object_value: { type: 'string' },
          predicate: { type: 'string' },
          source_chunk_no: { minimum: 0, type: 'integer' },
          subject: { type: 'string' },
        },
        required: ['subject', 'predicate', 'object_value', 'source_chunk_no', 'confidence'],
        type: 'object',
      },
      type: 'array',
    },
    chunks: {
      items: {
        additionalProperties: false,
        properties: {
          chunk_hash: HASH_SCHEMA,
          chunk_no: { minimum: 0, type: 'integer' },
          locator: {
            additionalProperties: false,
            properties: {
              char_end: { minimum: 0, type: 'integer' },
              char_start: { minimum: 0, type: 'integer' },
              page: NULLABLE_PAGE_SCHEMA,
              url: NULLABLE_URL_SCHEMA,
            },
            required: ['page', 'url', 'char_start', 'char_end'],
            type: 'object',
          },
          text: { minLength: 1, type: 'string' },
          token_count: { minimum: 1, type: 'integer' },
        },
        required: ['chunk_no', 'text', 'chunk_hash', 'token_count', 'locator'],
        type: 'object',
      },
      minItems: 1,
      type: 'array',
    },
    document: {
      additionalProperties: false,
      properties: {
        content_hash: HASH_SCHEMA,
        language: { type: 'string' },
        parser_version: { type: 'string' },
        title: { minLength: 1, type: 'string' },
      },
      required: ['title', 'language', 'content_hash', 'parser_version'],
      type: 'object',
    },
  },
  required: ['document', 'chunks', 'candidate_facts'],
  type: 'object',
});

export const MATERIAL_PARSER_OUTPUT_SCHEMA = createSkillResultSchema(
  MATERIAL_PARSER_SKILL_NAME,
  MATERIAL_PARSER_DATA_SCHEMA,
  'https://geo.example/schemas/material-parser-output-1.json',
);

export interface MaterialParserInput {
  readonly document_metadata: {
    readonly content_hash: string;
    readonly language: string;
    readonly mime_type: string;
    readonly source_document_id: string;
    readonly source_type: 'docx' | 'image' | 'pdf' | 'txt' | 'url';
    readonly title: string;
  };
  readonly extracted_text: string;
  readonly page_map: readonly MaterialParserLocator[];
  readonly parser_policy: {
    readonly max_tokens: number;
    readonly min_tokens: number;
    readonly overlap_tokens: 80;
    readonly target_tokens: number;
  };
}

export interface MaterialParserLocator {
  readonly char_end: number;
  readonly char_start: number;
  readonly page: number | null;
  readonly url: string | null;
}

export interface MaterialParserData {
  readonly candidate_facts: readonly {
    readonly confidence: number;
    readonly object_value: string;
    readonly predicate: string;
    readonly source_chunk_no: number;
    readonly subject: string;
  }[];
  readonly chunks: readonly {
    readonly chunk_hash: string;
    readonly chunk_no: number;
    readonly locator: MaterialParserLocator;
    readonly text: string;
    readonly token_count: number;
  }[];
  readonly document: {
    readonly content_hash: string;
    readonly language: string;
    readonly parser_version: string;
    readonly title: string;
  };
}

export type MaterialParserOutput = SkillResult<MaterialParserData, 'material-parser'>;
