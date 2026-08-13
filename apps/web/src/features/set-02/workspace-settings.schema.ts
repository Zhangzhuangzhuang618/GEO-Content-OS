import { z } from 'zod';

export const PlatformCodeSchema = z.enum([
  'official_site',
  'baijiahao',
  'sohu',
  'toutiao',
  'zhihu',
  'xiaohongshu',
  'wechat_mp',
  'douyin',
]);

const WorkspaceSettingsSchema = z
  .object({
    budget_policy: z
      .object({
        hard_limit: z.boolean(),
        monthly_limit_cny: z.number().nonnegative().max(1_000_000_000).nullable(),
      })
      .strict()
      .optional(),
    default_platform_codes: z.array(PlatformCodeSchema).min(1).max(8).optional(),
    review_policy: z
      .object({
        minimum_approvals: z.number().int().min(1).max(5),
        require_high_risk_signoff: z.boolean(),
      })
      .strict()
      .optional(),
    schema_version: z.literal('workspace-settings@1'),
  })
  .strict();

export const WorkspaceSchema = z
  .object({
    created_at: z.iso.datetime(),
    id: z.string().uuid(),
    name: z.string().min(1).max(120),
    settings: WorkspaceSettingsSchema,
    slug: z.string().min(1).max(80),
    status: z.enum(['active', 'archived']),
    tenant_id: z.string().uuid(),
    timezone: z.string().min(1).max(64),
    updated_at: z.iso.datetime(),
    version: z.number().int().positive(),
  })
  .strict();

export const WorkspacePageSchema = z
  .object({
    data: z.array(WorkspaceSchema),
    meta: z
      .object({ next_cursor: z.string().nullable(), request_id: z.string().min(1) })
      .passthrough(),
  })
  .strict();

export const WorkspaceResponseSchema = z
  .object({
    data: WorkspaceSchema,
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export const WorkspaceFormSchema = z.object({
  default_platform_codes: z.array(PlatformCodeSchema).min(1, '至少选择一个默认平台。'),
  hard_limit: z.boolean(),
  minimum_approvals: z.string().regex(/^[1-5]$/u, '审核人数必须是 1 到 5。'),
  monthly_limit_cny: z.string().refine((value) => {
    if (!value) return true;
    const amount = Number(value);
    return Number.isFinite(amount) && amount >= 0 && amount <= 1_000_000_000;
  }, '预算必须是 0 到 10 亿元之间的数字。'),
  name: z.string().trim().min(1, '请填写工作区名称。').max(120),
  require_high_risk_signoff: z.boolean(),
  slug: z
    .string()
    .trim()
    .min(1, '请填写 slug。')
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'slug 仅允许小写字母、数字和单连字符。'),
  timezone: z.string().trim().min(1, '请填写 IANA 时区。').max(64),
});

export type PlatformCode = z.infer<typeof PlatformCodeSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type WorkspaceForm = z.infer<typeof WorkspaceFormSchema>;
