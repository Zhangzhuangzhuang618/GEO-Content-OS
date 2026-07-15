import { z } from 'zod';

export const PlatformCodeSchema = z.enum([
  'official_site',
  'baijiahao',
  'toutiao',
  'zhihu',
  'xiaohongshu',
  'wechat_mp',
  'douyin',
]);
export const ReviewStatusSchema = z.enum(['in_review', 'approved', 'rejected', 'superseded']);
export const RiskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);
export const ClaimStateSchema = z.enum(['mine', 'unclaimed']);

export const ReviewInboxItemSchema = z
  .object({
    brand_profile_id: z.string().uuid(),
    claimed_at: z.iso.datetime().nullable(),
    claimed_by: z.string().uuid().nullable(),
    created_at: z.iso.datetime(),
    created_by: z.string().uuid(),
    due_at: z.iso.datetime().nullable(),
    id: z.string().uuid(),
    model_key: z.string().min(1),
    package_id: z.string().uuid(),
    pending_signoff_count: z.number().int().nonnegative(),
    platform_codes: z.array(PlatformCodeSchema).min(1).max(7),
    platform_rules_hash: z.string().length(64),
    project_id: z.string().uuid(),
    prompt_version_id: z.string().uuid(),
    quality_rules_hash: z.string().length(64),
    risk_level: RiskLevelSchema.nullable(),
    snapshot_hash: z.string().length(64),
    status: ReviewStatusSchema,
    tenant_id: z.string().uuid(),
    updated_at: z.iso.datetime(),
    variant_count: z.number().int().min(1).max(7),
    version: z.number().int().positive(),
    workspace_id: z.string().uuid(),
  })
  .strict();

export const ReviewInboxPageSchema = z
  .object({
    data: z.array(ReviewInboxItemSchema),
    meta: z.object({ next_cursor: z.string().nullable(), request_id: z.string().min(1) }).strict(),
  })
  .strict();

export const ReviewClaimResponseSchema = z
  .object({
    data: z
      .object({
        claimed_at: z.iso.datetime(),
        claimed_by: z.string().uuid(),
        due_at: z.iso.datetime(),
        risk_level: RiskLevelSchema,
        snapshot_id: z.string().uuid(),
        version: z.number().int().positive(),
      })
      .strict(),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export type ClaimState = z.infer<typeof ClaimStateSchema>;
export type PlatformCode = z.infer<typeof PlatformCodeSchema>;
export type ReviewInboxItem = z.infer<typeof ReviewInboxItemSchema>;
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export interface ReviewFilters {
  readonly claimState?: ClaimState;
  readonly createdBy?: string;
  readonly cursor?: string;
  readonly platformCode?: PlatformCode;
  readonly projectId?: string;
  readonly riskLevel?: RiskLevel;
  readonly status?: ReviewStatus;
  readonly workspaceId?: string;
}
