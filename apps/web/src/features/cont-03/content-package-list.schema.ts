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

export const ContentPackageStatusSchema = z.enum([
  'draft',
  'generating',
  'generated',
  'all_failed',
  'editing',
  'in_review',
  'rejected',
  'approved',
  'scheduled',
  'publishing',
  'publish_failed',
  'published',
  'cancelled',
  'archived',
]);

export const ContentVariantStatusSchema = z.enum([
  'draft',
  'generating',
  'generation_failed',
  'generated',
  'quality_failed',
  'quality_passed',
  'in_review',
  'review_approved',
  'review_rejected',
  'approved',
  'scheduled',
  'publishing',
  'published',
  'publish_failed',
  'cancelled',
]);

export const ContentPackageSchema = z
  .object({
    brief_id: z.string().uuid(),
    created_at: z.iso.datetime(),
    created_by: z.string().uuid(),
    id: z.string().uuid(),
    master_content_version_id: z.string().uuid().nullable(),
    project_id: z.string().uuid(),
    status: ContentPackageStatusSchema,
    tenant_id: z.string().uuid(),
    updated_at: z.iso.datetime(),
    version: z.number().int().positive(),
    workspace_id: z.string().uuid(),
  })
  .strict();

export const ContentVariantSchema = z
  .object({
    created_at: z.iso.datetime(),
    current_content_version_id: z.string().uuid().nullable(),
    id: z.string().uuid(),
    is_required: z.boolean(),
    package_id: z.string().uuid(),
    platform_code: PlatformCodeSchema,
    quality_score: z.number().min(0).max(100).nullable(),
    status: ContentVariantStatusSchema,
    tenant_id: z.string().uuid(),
    updated_at: z.iso.datetime(),
    version: z.number().int().positive(),
  })
  .strict();

export const ContentPackagePageSchema = z
  .object({
    data: z.array(ContentPackageSchema),
    meta: z.object({ next_cursor: z.string().nullable(), request_id: z.string().min(1) }).strict(),
  })
  .strict();

export const ContentPackageResponseSchema = z
  .object({
    data: ContentPackageSchema,
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export const ContentPackageDetailResponseSchema = z
  .object({
    data: z
      .object({
        generation_runs: z.array(z.unknown()),
        master_content: z.unknown().nullable(),
        package: ContentPackageSchema,
        variants: z.array(ContentVariantSchema).min(1).max(7),
      })
      .strict(),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export const CostBreakdownResponseSchema = z
  .object({
    data: z
      .object({
        breakdown: z.array(z.unknown()),
        package_totals: z.array(
          z
            .object({
              cost_cents: z.number().int().nonnegative(),
              currency: z.string().regex(/^[A-Z]{3}$/u),
              entry_count: z.number().int().nonnegative(),
              package_id: z.string().uuid(),
            })
            .strict(),
        ),
        settled_only: z.literal(true),
        totals: z.array(z.unknown()),
      })
      .strict(),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export type ContentPackage = z.infer<typeof ContentPackageSchema>;
export type ContentPackageStatus = z.infer<typeof ContentPackageStatusSchema>;
export type ContentVariant = z.infer<typeof ContentVariantSchema>;
export type PlatformCode = z.infer<typeof PlatformCodeSchema>;

export interface PackageFilters {
  readonly createdBy?: string;
  readonly cursor?: string;
  readonly platformCode?: PlatformCode;
  readonly projectId?: string;
  readonly search?: string;
  readonly status?: ContentPackageStatus;
  readonly workspaceId?: string;
}

export interface PackageListItem {
  readonly briefTitle: string;
  readonly costs: readonly { readonly costCents: number; readonly currency: string }[] | null;
  readonly package: ContentPackage;
  readonly variants: readonly ContentVariant[];
}
