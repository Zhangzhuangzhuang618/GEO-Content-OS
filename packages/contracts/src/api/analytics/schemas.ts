import { z } from 'zod';

import { PLATFORM_CODES } from '../../platforms.js';

import {
  CursorSchema,
  IsoDateTimeSchema,
  UuidSchema,
  createDataResponseSchema,
} from '../common.js';

const DateSchema = z.string().date();
const HashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const PlatformCodeSchema = z.enum([
  'official_site',
  'baijiahao',
  'sohu',
  'lieju',
  'toutiao',
  'zhihu',
  'xiaohongshu',
  'wechat_mp',
  'douyin',
]);
const OptionalPlatformCodesSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value),
  z.array(PlatformCodeSchema).max(PLATFORM_CODES.length).optional(),
);

export const AiVisibilityIntentCodeSchema = z.enum([
  'brand_recognition',
  'exploration',
  'recommendation',
  'comparison',
  'education',
  'procurement',
]);
export const AiVisibilityEngineCodeSchema = z.enum([
  'deepseek',
  'qwen',
  'kimi',
  'doubao',
  'wenxin',
  'yuanbao',
  'custom',
]);
const AiVisibilityRunStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
]);
const AiVisibilityCommercialValueSchema = z.enum(['low', 'medium', 'high']);

export const AnalyticsQuerySchema = z
  .object({
    from: DateSchema,
    platform_codes: OptionalPlatformCodesSchema,
    project_id: UuidSchema.optional(),
    to: DateSchema,
    workspace_id: UuidSchema,
  })
  .strict()
  .refine((query) => query.from <= query.to, { message: 'from must not be after to' });

export const ContentAnalyticsQuerySchema = AnalyticsQuerySchema.extend({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const CostQuerySchema = z
  .object({
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/u)
      .optional(),
    from: DateSchema,
    generation_run_id: UuidSchema.optional(),
    package_id: UuidSchema.optional(),
    project_id: UuidSchema.optional(),
    to: DateSchema,
    variant_id: UuidSchema.optional(),
    workspace_id: UuidSchema.optional(),
  })
  .strict()
  .refine((query) => query.from <= query.to, { message: 'from must not be after to' });

export const MetricAggregateSchema = z
  .object({
    aggregation: z.enum(['average', 'last', 'sum']),
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    unit: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u),
    value: z.number().finite().nullable(),
  })
  .strict();

export const VisibilityAggregateSchema = z
  .object({
    average_rank: z.number().finite().nullable(),
    citation_count: z.number().int().nonnegative(),
    citation_rate: z.number().min(0).max(1),
    observation_count: z.number().int().nonnegative(),
  })
  .strict();

export const OverviewMetricsSchema = z
  .object({
    data_updated_at: IsoDateTimeSchema.nullable(),
    methodology_version: z.string().min(1).max(64),
    metrics: z.array(MetricAggregateSchema),
    visibility: VisibilityAggregateSchema,
  })
  .strict();

export const PlatformMetricsSchema = z
  .object({
    data_updated_at: IsoDateTimeSchema.nullable(),
    methodology_version: z.string().min(1).max(64),
    platforms: z.array(
      z
        .object({
          data_updated_at: IsoDateTimeSchema.nullable(),
          metrics: z.array(MetricAggregateSchema),
          platform_code: PlatformCodeSchema,
          visibility: VisibilityAggregateSchema,
        })
        .strict(),
    ),
  })
  .strict();

export const ContentMetricsPageSchema = z
  .object({
    data_updated_at: IsoDateTimeSchema.nullable(),
    items: z.array(
      z
        .object({
          data_updated_at: IsoDateTimeSchema.nullable(),
          metrics: z.array(MetricAggregateSchema),
          package_id: UuidSchema,
          platform_code: PlatformCodeSchema,
          project_id: UuidSchema,
          variant_id: UuidSchema,
        })
        .strict(),
    ),
    methodology_version: z.string().min(1).max(64),
    next_cursor: CursorSchema.nullable(),
  })
  .strict();

export const CostBreakdownSchema = z
  .object({
    breakdown: z.array(
      z
        .object({
          cost_category: z.string().min(1),
          cost_cents: z.number().int().nonnegative(),
          currency: z.string().regex(/^[A-Z]{3}$/u),
          entry_count: z.number().int().nonnegative(),
          generation_run_id: UuidSchema.nullable(),
          model_key: z.string().nullable(),
          package_id: UuidSchema.nullable(),
          project_id: UuidSchema.nullable(),
          provider: z.string().nullable(),
          skill_name: z.string().nullable(),
          variant_id: UuidSchema.nullable(),
          workspace_id: UuidSchema.nullable(),
        })
        .strict(),
    ),
    package_totals: z.array(
      z
        .object({
          cost_cents: z.number().int().nonnegative(),
          currency: z.string().regex(/^[A-Z]{3}$/u),
          entry_count: z.number().int().nonnegative(),
          package_id: UuidSchema,
        })
        .strict(),
    ),
    settled_only: z.literal(true),
    totals: z.array(
      z
        .object({
          cost_cents: z.number().int().nonnegative(),
          currency: z.string().regex(/^[A-Z]{3}$/u),
          entry_count: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

export const CostBudgetQuerySchema = z
  .object({
    month: z.string().regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/u),
    workspace_id: UuidSchema,
  })
  .strict();

export const CostBudgetStatusSchema = z
  .object({
    consumed_cents: z.number().int().nonnegative(),
    currency: z.literal('CNY'),
    hard_limit: z.boolean(),
    is_exceeded: z.boolean(),
    is_exhausted: z.boolean(),
    limit_cents: z.number().int().nonnegative().nullable(),
    month: z.string().regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/u),
    remaining_cents: z.number().int().nonnegative().nullable(),
    workspace_id: UuidSchema,
  })
  .strict();

export const ProviderStatementLineSchema = z
  .object({
    billed_cost_cents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    provider: z.string().trim().min(1).max(80),
  })
  .strict();

export const CostReconciliationRequestSchema = CostQuerySchema.extend({
  statement_lines: z.array(ProviderStatementLineSchema).min(1).max(500),
});

export const CostReconciliationReportSchema = z
  .object({
    from: IsoDateTimeSchema,
    items: z.array(
      z
        .object({
          billed_cost_cents: z.number().int().nonnegative().nullable(),
          currency: z.string().regex(/^[A-Z]{3}$/u),
          delta_cents: z.number().int().nullable(),
          ledger_cost_cents: z.number().int().nonnegative(),
          provider: z.string().nullable(),
          status: z.enum(['matched', 'mismatch', 'missing_ledger', 'missing_statement']),
        })
        .strict(),
    ),
    settled_only: z.literal(true),
    to: IsoDateTimeSchema,
  })
  .strict();

export const ManualMetricRowSchema = z
  .object({
    account_id: UuidSchema.nullable().optional(),
    metric_date: DateSchema,
    metric_name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    metric_value: z.number().finite(),
    platform_code: PlatformCodeSchema,
    variant_id: UuidSchema.nullable().optional(),
  })
  .strict();

export const ManualMetricsRequestSchema = z
  .object({ rows: z.array(ManualMetricRowSchema).min(1).max(1_000), workspace_id: UuidSchema })
  .strict();

export const ImportJobParamsSchema = z.object({ id: UuidSchema }).strict();
export const MetricsImportMultipartSchema = z
  .object({
    file: z.string().meta({ format: 'binary' }),
    workspace_id: UuidSchema,
  })
  .strict();
export const RollbackImportRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(1_000) })
  .strict();
export const ImportJobViewSchema = z
  .object({
    content_hash: HashSchema.nullable(),
    created_at: IsoDateTimeSchema,
    error_json: z.record(z.string(), z.unknown()).nullable(),
    id: UuidSchema,
    row_count: z.number().int().nonnegative().nullable(),
    source: z.enum(['api', 'csv', 'manual']),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'rolled_back']),
    updated_at: IsoDateTimeSchema,
    workspace_id: UuidSchema,
  })
  .strict();

export const ManualMetricsResultSchema = z
  .object({
    duplicate_count: z.number().int().nonnegative(),
    errors: z.array(
      z.object({ index: z.number().int().nonnegative(), message: z.string() }).strict(),
    ),
    import_job_id: UuidSchema,
    inserted_count: z.number().int().nonnegative(),
    status: z.enum(['failed', 'succeeded']),
  })
  .strict();

export const MetricRecordViewSchema = z
  .object({
    account_id: UuidSchema.nullable(),
    created_at: IsoDateTimeSchema,
    id: UuidSchema,
    import_job_id: UuidSchema,
    metric_date: DateSchema,
    metric_name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    metric_value: z.number().finite(),
    platform_code: PlatformCodeSchema,
    source: z.enum(['api', 'csv', 'manual']),
    tenant_id: UuidSchema,
    variant_id: UuidSchema.nullable(),
    workspace_id: UuidSchema,
  })
  .strict();

const VisibilityObservationInputSchema = z
  .object({
    evidence_asset_id: UuidSchema.nullable().optional(),
    is_cited: z.boolean(),
    notes: z.string().trim().min(1).max(2_000).nullable().optional(),
    observed_at: IsoDateTimeSchema,
    platform_code: PlatformCodeSchema,
    query_text: z.string().trim().min(1).max(1_000),
    rank_position: z.number().int().positive().nullable().optional(),
  })
  .strict();

export const VisibilityObservationRequestSchema = VisibilityObservationInputSchema.extend({
  screenshot: z
    .object({
      body_base64: z.string().min(1),
      mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    })
    .strict()
    .optional(),
  workspace_id: UuidSchema,
})
  .strict()
  .refine((input) => !(input.evidence_asset_id && input.screenshot), {
    message: 'evidence_asset_id and screenshot are mutually exclusive',
  });

export const VisibilityImportRequestSchema = z
  .object({
    rows: z.array(VisibilityObservationInputSchema).min(1).max(1_000),
    workspace_id: UuidSchema,
  })
  .strict();

export const VisibilityTrendQuerySchema = z
  .object({
    from: DateSchema,
    platform_code: PlatformCodeSchema.optional(),
    query_text: z.string().trim().min(1).max(1_000).optional(),
    to: DateSchema,
    workspace_id: UuidSchema,
  })
  .strict()
  .refine((query) => query.from <= query.to, { message: 'from must not be after to' });

export const VisibilityObservationViewSchema = z
  .object({
    created_at: IsoDateTimeSchema,
    evidence_asset_id: UuidSchema.nullable(),
    id: UuidSchema,
    is_cited: z.boolean(),
    notes: z.string().nullable(),
    observed_at: IsoDateTimeSchema,
    platform_code: PlatformCodeSchema,
    query_hash: HashSchema,
    query_text: z.string().min(1),
    rank_position: z.number().int().positive().nullable(),
    tenant_id: UuidSchema,
    workspace_id: UuidSchema,
  })
  .strict();

export const VisibilityTrendPointSchema = z
  .object({
    average_rank: z.number().finite().nullable(),
    best_rank: z.number().int().positive().nullable(),
    citation_count: z.number().int().nonnegative(),
    citation_rate: z.number().min(0).max(1),
    day: DateSchema,
    observation_count: z.number().int().nonnegative(),
    platform_code: PlatformCodeSchema,
    query_hash: HashSchema,
    query_text: z.string().min(1),
  })
  .strict();

export const AiVisibilityQueryInputSchema = z
  .object({
    commercial_value: AiVisibilityCommercialValueSchema,
    intent_code: AiVisibilityIntentCodeSchema,
    query_text: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const AiVisibilityQuerySetCreateSchema = z
  .object({
    brand_aliases: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    brand_name: z.string().trim().min(1).max(200),
    competitor_names: z.array(z.string().trim().min(1).max(200)).min(2).max(10),
    industry: z.string().trim().min(1).max(200),
    locale: z.string().trim().min(2).max(16).default('zh-CN'),
    market: z.string().trim().min(1).max(200).nullable().optional(),
    name: z.string().trim().min(1).max(120),
    positioning: z.string().trim().min(1).max(2_000).nullable().optional(),
    project_id: UuidSchema,
    queries: z.array(AiVisibilityQueryInputSchema).min(6).max(60).optional(),
    workspace_id: UuidSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (!input.queries) return;
    const intents = new Set(input.queries.map((query) => query.intent_code));
    for (const intent of AiVisibilityIntentCodeSchema.options) {
      if (!intents.has(intent)) {
        context.addIssue({
          code: 'custom',
          message: `queries must include intent ${intent}`,
          path: ['queries'],
        });
      }
    }
  });

export const AiVisibilityQuerySetListQuerySchema = z
  .object({
    project_id: UuidSchema.optional(),
    status: z.enum(['active', 'archived']).default('active'),
    workspace_id: UuidSchema,
  })
  .strict();

export const AiVisibilityRunCreateSchema = z
  .object({
    baseline_run_id: UuidSchema.nullable().optional(),
    engine_codes: z.array(AiVisibilityEngineCodeSchema).min(1).max(7).default(['deepseek']),
    query_set_id: UuidSchema,
    workspace_id: UuidSchema,
  })
  .strict();

export const AiVisibilityRunListQuerySchema = z
  .object({
    engine_code: AiVisibilityEngineCodeSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    project_id: UuidSchema.optional(),
    query_set_id: UuidSchema.optional(),
    status: AiVisibilityRunStatusSchema.optional(),
    workspace_id: UuidSchema,
  })
  .strict();

export const AiVisibilityRunParamsSchema = z.object({ id: UuidSchema }).strict();
export const AiVisibilityRunDetailQuerySchema = z.object({ workspace_id: UuidSchema }).strict();

export const AiVisibilityQueryViewSchema = z
  .object({
    commercial_value: AiVisibilityCommercialValueSchema,
    created_at: IsoDateTimeSchema,
    id: UuidSchema,
    intent_code: AiVisibilityIntentCodeSchema,
    query_hash: HashSchema,
    query_key: z.string().regex(/^q[0-9]{3}$/u),
    query_text: z.string().min(1),
    sort_order: z.number().int().positive(),
  })
  .strict();

export const AiVisibilityQuerySetViewSchema = z
  .object({
    brand_aliases: z.array(z.string()),
    brand_name: z.string().min(1),
    competitor_names: z.array(z.string()).min(2),
    created_at: IsoDateTimeSchema,
    created_by: UuidSchema,
    id: UuidSchema,
    industry: z.string().min(1),
    locale: z.string().min(1),
    market: z.string().nullable(),
    methodology_version: z.string().min(1),
    name: z.string().min(1),
    positioning: z.string().nullable(),
    project_id: UuidSchema,
    queries: z.array(AiVisibilityQueryViewSchema).min(1),
    query_count: z.number().int().positive(),
    revision: z.number().int().positive(),
    series_id: UuidSchema,
    status: z.enum(['active', 'archived']),
    updated_at: IsoDateTimeSchema,
    workspace_id: UuidSchema,
  })
  .strict();

export const AiVisibilityMetricsSchema = z
  .object({
    answered_count: z.number().int().nonnegative(),
    average_rank: z.number().finite().positive().nullable(),
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

export const AiVisibilityCompetitorMetricSchema = z
  .object({
    average_rank: z.number().finite().positive().nullable(),
    mention_count: z.number().int().nonnegative(),
    mention_rate: z.number().min(0).max(1),
    name: z.string().min(1),
  })
  .strict();

export const AiVisibilitySourceMetricSchema = z
  .object({
    domain: z.string().min(1),
    intent_codes: z.array(AiVisibilityIntentCodeSchema),
    level: z.enum(['domain', 'url']),
    mention_count: z.number().int().positive(),
    query_count: z.number().int().positive(),
    url: z.string().url().nullable(),
  })
  .strict();

export const AiVisibilityOpportunitySchema = z
  .object({
    commercial_value: AiVisibilityCommercialValueSchema,
    competitors_mentioned: z.array(z.string()),
    intent_code: AiVisibilityIntentCodeSchema,
    query_id: UuidSchema,
    query_key: z.string().regex(/^q[0-9]{3}$/u),
    query_text: z.string().min(1),
  })
  .strict();

export const AiVisibilityRunSummarySchema = z
  .object({
    baseline_run_id: UuidSchema.nullable(),
    completed_count: z.number().int().nonnegative(),
    competitors: z.array(AiVisibilityCompetitorMetricSchema),
    created_at: IsoDateTimeSchema,
    engine_code: AiVisibilityEngineCodeSchema,
    error_json: z.record(z.string(), z.unknown()).nullable(),
    failed_count: z.number().int().nonnegative(),
    finished_at: IsoDateTimeSchema.nullable(),
    id: UuidSchema,
    methodology_version: z.string().min(1),
    metrics: AiVisibilityMetricsSchema.nullable(),
    model_key: z.string().min(1),
    opportunities: z.array(AiVisibilityOpportunitySchema),
    project_id: UuidSchema,
    query_count: z.number().int().positive(),
    query_set_id: UuidSchema,
    requested_by: UuidSchema,
    retrieval_mode: z.enum(['model_only', 'search_api', 'imported']),
    score: z.number().min(0).max(100).nullable(),
    scoring_version: z.string().min(1),
    sources: z.array(AiVisibilitySourceMetricSchema),
    started_at: IsoDateTimeSchema.nullable(),
    status: AiVisibilityRunStatusSchema,
    updated_at: IsoDateTimeSchema,
    version: z.number().int().positive(),
    workspace_id: UuidSchema,
  })
  .strict();

export const AiVisibilityResponseViewSchema = z
  .object({
    answer_text: z.string().min(1).nullable(),
    citations: z.array(
      z
        .object({
          domain: z.string().min(1),
          title: z.string().nullable(),
          url: z.string().url(),
        })
        .strict(),
    ),
    competitors_mentioned: z.array(z.string()),
    error_json: z.record(z.string(), z.unknown()).nullable(),
    id: UuidSchema,
    observed_at: IsoDateTimeSchema,
    provider_request_id: z.string().nullable(),
    query: AiVisibilityQueryViewSchema,
    recommended: z.boolean(),
    recognition_status: z.enum([
      'not_applicable',
      'recognized',
      'not_recognized',
      'misidentified',
      'uncertain',
    ]),
    response_hash: HashSchema.nullable(),
    sentiment: z.enum(['positive', 'neutral', 'negative', 'unknown']),
    target_mentioned: z.boolean(),
    target_rank: z.number().int().positive().nullable(),
    usage: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();

export const AiVisibilityRunDetailSchema = AiVisibilityRunSummarySchema.extend({
  query_set: AiVisibilityQuerySetViewSchema,
  responses: z.array(AiVisibilityResponseViewSchema),
});

export const AnalyticsExportQuerySchema = AnalyticsQuerySchema.extend({
  format: z.enum(['csv']).default('csv'),
});

export const AnalyticsExportJobViewSchema = z
  .object({
    content_hash: HashSchema.nullable(),
    created_at: IsoDateTimeSchema,
    error_json: z.record(z.string(), z.unknown()).nullable(),
    expires_at: IsoDateTimeSchema.nullable(),
    id: UuidSchema,
    object_uri: z.string().min(1).nullable(),
    query_hash: HashSchema,
    requested_by: UuidSchema,
    row_count: z.number().int().nonnegative().nullable(),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'expired']),
    tenant_id: UuidSchema,
    updated_at: IsoDateTimeSchema,
    version: z.number().int().positive(),
    workspace_id: UuidSchema.nullable(),
  })
  .strict();

export const OverviewMetricsResponseSchema = createDataResponseSchema(OverviewMetricsSchema);
export const PlatformMetricsResponseSchema = createDataResponseSchema(PlatformMetricsSchema);
export const ContentMetricsResponseSchema = createDataResponseSchema(ContentMetricsPageSchema);
export const CostBreakdownResponseSchema = createDataResponseSchema(CostBreakdownSchema);
export const CostBudgetStatusResponseSchema = createDataResponseSchema(CostBudgetStatusSchema);
export const CostReconciliationResponseSchema = createDataResponseSchema(
  CostReconciliationReportSchema,
);
export const ImportJobResponseSchema = createDataResponseSchema(ImportJobViewSchema);
export const ManualMetricsResponseSchema = createDataResponseSchema(
  z.array(MetricRecordViewSchema),
);
export const VisibilityObservationResponseSchema = createDataResponseSchema(
  VisibilityObservationViewSchema,
);
export const VisibilityImportResponseSchema = createDataResponseSchema(
  z.array(VisibilityObservationViewSchema),
);
export const VisibilityTrendResponseSchema = createDataResponseSchema(
  z.array(VisibilityTrendPointSchema),
);
export const AiVisibilityQuerySetResponseSchema = createDataResponseSchema(
  AiVisibilityQuerySetViewSchema,
);
export const AiVisibilityQuerySetListResponseSchema = createDataResponseSchema(
  z.array(AiVisibilityQuerySetViewSchema),
);
export const AiVisibilityRunCreateResponseSchema = createDataResponseSchema(
  z.array(AiVisibilityRunSummarySchema),
);
export const AiVisibilityRunListResponseSchema = createDataResponseSchema(
  z.array(AiVisibilityRunSummarySchema),
);
export const AiVisibilityRunDetailResponseSchema = createDataResponseSchema(
  AiVisibilityRunDetailSchema,
);
export const UsageSummaryResponseSchema = CostBreakdownResponseSchema;
export const AnalyticsExportJobResponseSchema = createDataResponseSchema(
  AnalyticsExportJobViewSchema,
);

export type AnalyticsExportQuery = z.infer<typeof AnalyticsExportQuerySchema>;
export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;
export type AiVisibilityQuerySetCreate = z.infer<typeof AiVisibilityQuerySetCreateSchema>;
export type AiVisibilityQuerySetListQuery = z.infer<typeof AiVisibilityQuerySetListQuerySchema>;
export type AiVisibilityRunCreate = z.infer<typeof AiVisibilityRunCreateSchema>;
export type AiVisibilityRunListQuery = z.infer<typeof AiVisibilityRunListQuerySchema>;
export type AiVisibilityQuerySetView = z.infer<typeof AiVisibilityQuerySetViewSchema>;
export type AiVisibilityRunSummary = z.infer<typeof AiVisibilityRunSummarySchema>;
export type AiVisibilityRunDetail = z.infer<typeof AiVisibilityRunDetailSchema>;
export type CostQuery = z.infer<typeof CostQuerySchema>;
export type CostBudgetQuery = z.infer<typeof CostBudgetQuerySchema>;
export type CostReconciliationRequest = z.infer<typeof CostReconciliationRequestSchema>;
export type ManualMetricsRequest = z.infer<typeof ManualMetricsRequestSchema>;
export type VisibilityImportRequest = z.infer<typeof VisibilityImportRequestSchema>;
export type VisibilityObservationRequest = z.infer<typeof VisibilityObservationRequestSchema>;
export type VisibilityTrendQuery = z.infer<typeof VisibilityTrendQuerySchema>;
