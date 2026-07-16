import { z } from 'zod';

import { PlatformCodeSchema } from '../pub-01/platform-account.schema';

export const MetricSchema = z
  .object({
    aggregation: z.enum(['average', 'last', 'sum']),
    name: z.string(),
    unit: z.string(),
    value: z.number().nullable(),
  })
  .strict();
const VisibilitySchema = z
  .object({
    average_rank: z.number().nullable(),
    citation_count: z.number().int().nonnegative(),
    citation_rate: z.number().min(0).max(1),
    observation_count: z.number().int().nonnegative(),
  })
  .strict();
const MetaSchema = z.object({ request_id: z.string().min(1) }).passthrough();
export const OverviewResponseSchema = z
  .object({
    data: z
      .object({
        data_updated_at: z.iso.datetime().nullable(),
        methodology_version: z.string().min(1),
        metrics: z.array(MetricSchema),
        visibility: VisibilitySchema,
      })
      .strict(),
    meta: MetaSchema,
  })
  .strict();
export const PlatformsResponseSchema = z
  .object({
    data: z
      .object({
        data_updated_at: z.iso.datetime().nullable(),
        methodology_version: z.string().min(1),
        platforms: z.array(
          z
            .object({
              data_updated_at: z.iso.datetime().nullable(),
              metrics: z.array(MetricSchema),
              platform_code: PlatformCodeSchema,
              visibility: VisibilitySchema,
            })
            .strict(),
        ),
      })
      .strict(),
    meta: MetaSchema,
  })
  .strict();
export const CostsResponseSchema = z
  .object({
    data: z
      .object({
        breakdown: z.array(z.unknown()),
        package_totals: z.array(z.unknown()),
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
      .strict(),
    meta: MetaSchema,
  })
  .strict();
export const ExportResponseSchema = z
  .object({
    data: z
      .object({
        content_hash: z.string().nullable(),
        created_at: z.iso.datetime(),
        error_json: z.record(z.string(), z.unknown()).nullable(),
        expires_at: z.iso.datetime().nullable(),
        id: z.string().uuid(),
        object_uri: z.string().nullable(),
        query_hash: z.string().regex(/^[0-9a-f]{64}$/u),
        requested_by: z.string().uuid(),
        row_count: z.number().int().nonnegative().nullable(),
        status: z.enum(['queued', 'running', 'succeeded', 'failed', 'expired']),
        tenant_id: z.string().uuid(),
        updated_at: z.iso.datetime(),
        version: z.number().int().positive(),
        workspace_id: z.string().uuid().nullable(),
      })
      .strict(),
    meta: MetaSchema,
  })
  .strict();

export interface AnalyticsFilters {
  readonly from: string;
  readonly platformCodes?: readonly z.infer<typeof PlatformCodeSchema>[];
  readonly projectId?: string;
  readonly to: string;
  readonly workspaceId?: string;
}
export type Overview = z.infer<typeof OverviewResponseSchema>['data'];
export type Platforms = z.infer<typeof PlatformsResponseSchema>['data'];
export type Costs = z.infer<typeof CostsResponseSchema>['data'];
export type ExportJob = z.infer<typeof ExportResponseSchema>['data'];
