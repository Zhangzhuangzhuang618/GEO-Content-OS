import { z } from 'zod';

const ListSchema = z.array(z.string().trim().min(1).max(500));

export const BrandProfileDataSchema = z
  .object({
    audience: ListSchema.min(1).max(50),
    banned: ListSchema.max(100),
    compliance: ListSchema.max(100),
    cta: z.string().trim().min(1).max(500).nullable(),
    differentiators: ListSchema.max(50),
    positioning: z.string().trim().min(1).max(2_000),
    tone: z.string().trim().min(1).max(240),
  })
  .strict();

export const BrandProfileViewSchema = z
  .object({
    created_at: z.iso.datetime(),
    created_by: z.string().uuid(),
    id: z.string().uuid(),
    profile: BrandProfileDataSchema,
    published_at: z.iso.datetime().nullable(),
    schema_version: z.literal('brand-profile@1'),
    status: z.enum(['draft', 'published', 'retired']),
    tenant_id: z.string().uuid(),
    version: z.number().int().positive(),
    workspace_id: z.string().uuid(),
  })
  .strict();

export const BrandProfileResponseSchema = z
  .object({
    data: BrandProfileViewSchema,
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export const WorkspacePageSchema = z
  .object({
    data: z.array(
      z
        .object({
          id: z.string().uuid(),
          name: z.string().min(1),
          status: z.enum(['active', 'archived']),
        })
        .passthrough(),
    ),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .passthrough();

export const BrandProfileFormSchema = z.object({
  audience: z.string().trim().min(1, '至少填写一项受众。'),
  banned: z.string(),
  compliance: z.string(),
  cta: z.string().max(500, 'CTA 最多 500 个字符。'),
  differentiators: z.string(),
  positioning: z.string().trim().min(1, '请填写品牌定位。').max(2_000),
  tone: z.string().trim().min(1, '请填写品牌语气。').max(240),
  workspace_id: z.string().uuid('请选择工作区。'),
});

export type BrandProfileForm = z.infer<typeof BrandProfileFormSchema>;
export type BrandProfileView = z.infer<typeof BrandProfileViewSchema>;
export type WorkspaceChoice = z.infer<typeof WorkspacePageSchema>['data'][number];
