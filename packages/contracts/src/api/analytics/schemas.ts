import { z } from 'zod';

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
  'toutiao',
  'zhihu',
  'xiaohongshu',
  'wechat_mp',
  'douyin',
]);
const OptionalPlatformCodesSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value),
  z.array(PlatformCodeSchema).max(7).optional(),
);

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

export const VisibilityObservationRequestSchema = z
  .object({
    evidence_asset_id: UuidSchema.nullable().optional(),
    is_cited: z.boolean(),
    notes: z.string().trim().min(1).max(2_000).nullable().optional(),
    observed_at: IsoDateTimeSchema,
    platform_code: PlatformCodeSchema,
    query_text: z.string().trim().min(1).max(1_000),
    rank_position: z.number().int().positive().nullable().optional(),
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
export const ImportJobResponseSchema = createDataResponseSchema(ImportJobViewSchema);
export const ManualMetricsResponseSchema = createDataResponseSchema(
  z.array(MetricRecordViewSchema),
);
export const VisibilityObservationResponseSchema = createDataResponseSchema(
  VisibilityObservationViewSchema,
);
export const UsageSummaryResponseSchema = CostBreakdownResponseSchema;
export const AnalyticsExportJobResponseSchema = createDataResponseSchema(
  AnalyticsExportJobViewSchema,
);

export type AnalyticsExportQuery = z.infer<typeof AnalyticsExportQuerySchema>;
export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;
export type CostQuery = z.infer<typeof CostQuerySchema>;
export type ManualMetricsRequest = z.infer<typeof ManualMetricsRequestSchema>;
export type VisibilityObservationRequest = z.infer<typeof VisibilityObservationRequestSchema>;
