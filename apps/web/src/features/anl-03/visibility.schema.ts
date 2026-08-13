import { z } from 'zod';

const PlatformSchema = z.enum([
  'official_site',
  'baijiahao',
  'sohu',
  'toutiao',
  'zhihu',
  'xiaohongshu',
  'wechat_mp',
  'douyin',
]);
const ObservationSchema = z
  .object({
    created_at: z.iso.datetime(),
    evidence_asset_id: z.string().uuid().nullable(),
    id: z.string().uuid(),
    is_cited: z.boolean(),
    notes: z.string().nullable(),
    observed_at: z.iso.datetime(),
    platform_code: PlatformSchema,
    query_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    query_text: z.string().min(1),
    rank_position: z.number().int().positive().nullable(),
    tenant_id: z.string().uuid(),
    workspace_id: z.string().uuid(),
  })
  .strict();
const TrendPointSchema = z
  .object({
    average_rank: z.number().finite().nullable(),
    best_rank: z.number().int().positive().nullable(),
    citation_count: z.number().int().nonnegative(),
    citation_rate: z.number().min(0).max(1),
    day: z.string().date(),
    observation_count: z.number().int().nonnegative(),
    platform_code: PlatformSchema,
    query_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    query_text: z.string().min(1),
  })
  .strict();
const MetaSchema = z.object({ request_id: z.string().min(1) }).passthrough();
export const ObservationResponseSchema = z
  .object({ data: ObservationSchema, meta: MetaSchema })
  .strict();
export const ImportResponseSchema = z
  .object({ data: z.array(ObservationSchema), meta: MetaSchema })
  .strict();
export const TrendResponseSchema = z
  .object({ data: z.array(TrendPointSchema), meta: MetaSchema })
  .strict();
export type Platform = z.infer<typeof PlatformSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type TrendPoint = z.infer<typeof TrendPointSchema>;
export interface VisibilityFilters {
  readonly from: string;
  readonly platformCode?: Platform;
  readonly queryText?: string;
  readonly to: string;
  readonly workspaceId: string;
}
export interface VisibilityInput {
  readonly evidence_asset_id?: string | null;
  readonly is_cited: boolean;
  readonly notes?: string | null;
  readonly observed_at: string;
  readonly platform_code: Platform;
  readonly query_text: string;
  readonly rank_position?: number | null;
}
