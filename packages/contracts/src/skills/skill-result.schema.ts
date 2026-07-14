import type { JsonSchema } from './schema.types.js';

const ISSUE_SCHEMA = Object.freeze({
  additionalProperties: false,
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
    path: { type: ['string', 'null'] },
  },
  required: ['code', 'message'],
  type: 'object',
});

const CITATION_SCHEMA = Object.freeze({
  additionalProperties: false,
  properties: {
    chunk_id: { format: 'uuid', type: 'string' },
    quote_text: { minLength: 1, type: 'string' },
    source_id: { format: 'uuid', type: 'string' },
  },
  required: ['source_id', 'chunk_id', 'quote_text'],
  type: 'object',
});

const USAGE_SCHEMA = Object.freeze({
  additionalProperties: false,
  properties: {
    cost_cents: { minimum: 0, type: 'integer' },
    input_tokens: { minimum: 0, type: 'integer' },
    model_key: { type: 'string' },
    output_tokens: { minimum: 0, type: 'integer' },
    provider: { type: 'string' },
  },
  required: ['provider', 'model_key', 'input_tokens', 'output_tokens', 'cost_cents'],
  type: 'object',
});

const TRACE_SCHEMA = Object.freeze({
  additionalProperties: false,
  properties: {
    input_hash: { pattern: '^[a-f0-9]{64}$', type: 'string' },
    prompt_version_id: { format: 'uuid', type: 'string' },
    request_id: { minLength: 16, type: 'string' },
    run_id: { format: 'uuid', type: 'string' },
  },
  required: ['run_id', 'request_id', 'prompt_version_id', 'input_hash'],
  type: 'object',
});

export function createSkillResultSchema(
  skillName: string,
  dataSchema: JsonSchema,
  schemaId: string,
): JsonSchema {
  const embeddedDataSchema = Object.fromEntries(
    Object.entries(dataSchema).filter(([key]) => key !== '$id' && key !== '$schema'),
  ) as JsonSchema;
  return Object.freeze({
    $id: schemaId,
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    additionalProperties: false,
    properties: {
      blockers: { items: ISSUE_SCHEMA, type: 'array' },
      citations: { items: CITATION_SCHEMA, type: 'array' },
      data: embeddedDataSchema,
      skill_name: { const: skillName, type: 'string' },
      skill_version: { pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+$', type: 'string' },
      status: { enum: ['success', 'partial', 'failed'] },
      trace: TRACE_SCHEMA,
      usage: USAGE_SCHEMA,
      warnings: { items: ISSUE_SCHEMA, type: 'array' },
    },
    required: [
      'skill_name',
      'skill_version',
      'status',
      'data',
      'warnings',
      'blockers',
      'citations',
      'usage',
      'trace',
    ],
    type: 'object',
  });
}
