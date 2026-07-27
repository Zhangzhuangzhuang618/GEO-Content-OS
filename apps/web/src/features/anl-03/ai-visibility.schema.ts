import { z } from 'zod';

export const AiVisibilityIntentSchema = z.enum([
  'brand_recognition',
  'exploration',
  'recommendation',
  'comparison',
  'education',
  'procurement',
]);
const EngineSchema = z.enum(['deepseek', 'qwen', 'kimi', 'doubao', 'wenxin', 'yuanbao', 'custom']);
const RunStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
]);
const QuerySchema = z
  .object({
    commercial_value: z.enum(['low', 'medium', 'high']),
    created_at: z.iso.datetime(),
    id: z.string().uuid(),
    intent_code: AiVisibilityIntentSchema,
    query_hash: z.string().length(64),
    query_key: z.string(),
    query_text: z.string().min(1),
    sort_order: z.number().int().positive(),
  })
  .strict();
export const QuerySetSchema = z
  .object({
    brand_aliases: z.array(z.string()),
    brand_name: z.string().min(1),
    competitor_names: z.array(z.string()),
    created_at: z.iso.datetime(),
    created_by: z.string().uuid(),
    id: z.string().uuid(),
    industry: z.string().min(1),
    locale: z.string().min(1),
    market: z.string().nullable(),
    methodology_version: z.string().min(1),
    name: z.string().min(1),
    positioning: z.string().nullable(),
    project_id: z.string().uuid(),
    queries: z.array(QuerySchema),
    query_count: z.number().int().positive(),
    revision: z.number().int().positive(),
    series_id: z.string().uuid(),
    status: z.enum(['active', 'archived']),
    updated_at: z.iso.datetime(),
    workspace_id: z.string().uuid(),
  })
  .strict();
const MetricsSchema = z
  .object({
    answered_count: z.number().int().nonnegative(),
    average_rank: z.number().positive().nullable(),
    mention_rate: z.number().min(0).max(1),
    misidentified_count: z.number().int().nonnegative(),
    natural_answered_count: z.number().int().nonnegative(),
    positive_sentiment_rate: z.number().min(0).max(1),
    rank_score: z.number().min(0).max(1),
    ranked_count: z.number().int().nonnegative(),
    recognized_count: z.number().int().nonnegative(),
    recognition_rate: z.number().min(0).max(1),
    recommendation_rate: z.number().min(0).max(1),
    score: z.number().min(0).max(100),
    total_count: z.number().int().positive(),
  })
  .strict();
const CompetitorSchema = z
  .object({
    average_rank: z.number().positive().nullable(),
    mention_count: z.number().int().nonnegative(),
    mention_rate: z.number().min(0).max(1),
    name: z.string().min(1),
  })
  .strict();
const SourceSchema = z
  .object({
    domain: z.string().min(1),
    intent_codes: z.array(AiVisibilityIntentSchema),
    level: z.enum(['domain', 'url']),
    mention_count: z.number().int().positive(),
    query_count: z.number().int().positive(),
    url: z.string().url().nullable(),
  })
  .strict();
const OpportunitySchema = z
  .object({
    commercial_value: z.enum(['low', 'medium', 'high']),
    competitors_mentioned: z.array(z.string()),
    intent_code: AiVisibilityIntentSchema,
    query_id: z.string().uuid(),
    query_key: z.string(),
    query_text: z.string().min(1),
  })
  .strict();
export const RunSummarySchema = z
  .object({
    baseline_run_id: z.string().uuid().nullable(),
    completed_count: z.number().int().nonnegative(),
    competitors: z.array(CompetitorSchema),
    created_at: z.iso.datetime(),
    engine_code: EngineSchema,
    error_json: z.record(z.string(), z.unknown()).nullable(),
    failed_count: z.number().int().nonnegative(),
    finished_at: z.iso.datetime().nullable(),
    id: z.string().uuid(),
    methodology_version: z.string().min(1),
    metrics: MetricsSchema.nullable(),
    model_key: z.string().min(1),
    opportunities: z.array(OpportunitySchema),
    project_id: z.string().uuid(),
    query_count: z.number().int().positive(),
    query_set_id: z.string().uuid(),
    requested_by: z.string().uuid(),
    retrieval_mode: z.enum(['model_only', 'search_api', 'imported']),
    score: z.number().min(0).max(100).nullable(),
    scoring_version: z.string().min(1),
    sources: z.array(SourceSchema),
    started_at: z.iso.datetime().nullable(),
    status: RunStatusSchema,
    updated_at: z.iso.datetime(),
    version: z.number().int().positive(),
    workspace_id: z.string().uuid(),
  })
  .strict();
const ResponseSchema = z
  .object({
    answer_text: z.string().min(1).nullable(),
    citations: z.array(
      z
        .object({ domain: z.string(), title: z.string().nullable(), url: z.string().url() })
        .strict(),
    ),
    competitors_mentioned: z.array(z.string()),
    error_json: z.record(z.string(), z.unknown()).nullable(),
    id: z.string().uuid(),
    observed_at: z.iso.datetime(),
    provider_request_id: z.string().nullable(),
    query: QuerySchema,
    recommended: z.boolean(),
    recognition_status: z.enum([
      'not_applicable',
      'recognized',
      'not_recognized',
      'misidentified',
      'uncertain',
    ]),
    response_hash: z.string().length(64).nullable(),
    sentiment: z.enum(['positive', 'neutral', 'negative', 'unknown']),
    target_mentioned: z.boolean(),
    target_rank: z.number().int().positive().nullable(),
    usage: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
export const RunDetailSchema = RunSummarySchema.extend({
  query_set: QuerySetSchema,
  responses: z.array(ResponseSchema),
});
const MetaSchema = z.object({ request_id: z.string().min(1) }).passthrough();
export const QuerySetResponseSchema = z.object({ data: QuerySetSchema, meta: MetaSchema }).strict();
export const QuerySetListResponseSchema = z
  .object({ data: z.array(QuerySetSchema), meta: MetaSchema })
  .strict();
export const RunCreateResponseSchema = z
  .object({ data: z.array(RunSummarySchema), meta: MetaSchema })
  .strict();
export const RunListResponseSchema = z
  .object({ data: z.array(RunSummarySchema), meta: MetaSchema })
  .strict();
export const RunDetailResponseSchema = z
  .object({ data: RunDetailSchema, meta: MetaSchema })
  .strict();

export type AiVisibilityQuerySet = z.infer<typeof QuerySetSchema>;
export type AiVisibilityRunSummary = z.infer<typeof RunSummarySchema>;
export type AiVisibilityRunDetail = z.infer<typeof RunDetailSchema>;
export type AiVisibilityIntent = z.infer<typeof AiVisibilityIntentSchema>;
