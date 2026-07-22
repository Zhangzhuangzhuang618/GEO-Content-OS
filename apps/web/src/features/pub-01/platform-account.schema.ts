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

export const PlatformAccountStatusSchema = z.enum(['active', 'reauth', 'disabled']);

export const PlatformAccountSchema = z
  .object({
    capabilities: z.record(z.string(), z.unknown()),
    created_at: z.iso.datetime(),
    display_name: z.string().min(1).max(120),
    id: z.string().uuid(),
    platform_code: PlatformCodeSchema,
    provider_account_id: z.string().nullable(),
    publishing_url: z.url().nullable(),
    publish_mode: z.enum(['api', 'export', 'manual']),
    scopes: z.array(z.string()),
    status: PlatformAccountStatusSchema,
    tenant_id: z.string().uuid(),
    timezone: z.string().min(1).max(64),
    token_expires_at: z.iso.datetime().nullable(),
    updated_at: z.iso.datetime(),
    version: z.number().int().positive(),
    workspace_id: z.string().uuid(),
  })
  .strict();

const ResponseMetaSchema = z.object({ request_id: z.string().min(1) }).passthrough();

export const PlatformAccountPageSchema = z
  .object({ data: z.array(PlatformAccountSchema), meta: ResponseMetaSchema })
  .strict();

export const PlatformAccountResponseSchema = z
  .object({ data: PlatformAccountSchema, meta: ResponseMetaSchema })
  .strict();

export const CapabilityResponseSchema = z
  .object({
    data: z
      .object({
        account_id: z.string().uuid(),
        capabilities: z.record(z.string(), z.unknown()),
        checked_at: z.iso.datetime(),
        publish_mode: z.enum(['api', 'export', 'manual']),
        status: PlatformAccountStatusSchema,
        version: z.number().int().positive(),
      })
      .strict(),
    meta: ResponseMetaSchema,
  })
  .strict();

export const PlatformAccountFormSchema = z
  .object({
    base_url: z.string(),
    bearer_token: z.string(),
    display_name: z.string().trim().min(1, '请填写账号名称。').max(120),
    platform_code: PlatformCodeSchema,
    publishing_url: z.string(),
    publish_mode: z.enum(['api', 'export', 'manual']),
    timezone: z.string().trim().min(1, '请填写 IANA 时区。').max(64),
    workspace_id: z.string().uuid('请选择有效工作区。'),
  })
  .superRefine((value, context) => {
    if (value.publishing_url.trim() && !isHttpUrl(value.publishing_url.trim())) {
      context.addIssue({
        code: 'custom',
        message: '发布后台地址必须是有效的 HTTP 或 HTTPS 地址。',
        path: ['publishing_url'],
      });
    }
    if (value.publish_mode !== 'api') return;
    if (!z.url().safeParse(value.base_url.trim()).success) {
      context.addIssue({
        code: 'custom',
        message: 'API 模式需要有效的 HTTPS 地址。',
        path: ['base_url'],
      });
    }
    if (!value.base_url.trim().startsWith('https://')) {
      context.addIssue({ code: 'custom', message: 'API 地址必须使用 HTTPS。', path: ['base_url'] });
    }
    if (!value.bearer_token.trim()) {
      context.addIssue({
        code: 'custom',
        message: 'API 模式需要访问令牌。',
        path: ['bearer_token'],
      });
    }
  });

export const PlatformAccountEditSchema = z
  .object({
    base_url: z.string(),
    bearer_token: z.string(),
    display_name: z.string().trim().min(1, '请填写账号名称。').max(120),
    publishing_url: z.string(),
    publish_mode: z.enum(['api', 'export', 'manual']),
    timezone: z.string().trim().min(1, '请填写 IANA 时区。').max(64),
  })
  .superRefine((value, context) => {
    if (value.publishing_url.trim() && !isHttpUrl(value.publishing_url.trim())) {
      context.addIssue({
        code: 'custom',
        message: '发布后台地址必须是有效的 HTTP 或 HTTPS 地址。',
        path: ['publishing_url'],
      });
    }
    const baseUrl = value.base_url.trim();
    const token = value.bearer_token.trim();
    if (!baseUrl && !token) return;
    if (!z.url().safeParse(baseUrl).success || !baseUrl.startsWith('https://')) {
      context.addIssue({
        code: 'custom',
        message: '更新凭证时，API 地址必须是有效的 HTTPS 地址。',
        path: ['base_url'],
      });
    }
    if (!token) {
      context.addIssue({
        code: 'custom',
        message: '更新凭证时必须同时填写访问令牌。',
        path: ['bearer_token'],
      });
    }
  });

function isHttpUrl(value: string) {
  const parsed = z.url().safeParse(value);
  if (!parsed.success) return false;
  return ['http:', 'https:'].includes(new URL(parsed.data).protocol);
}

export type PlatformAccount = z.infer<typeof PlatformAccountSchema>;
export type PlatformAccountForm = z.infer<typeof PlatformAccountFormSchema>;
export type PlatformAccountEdit = z.infer<typeof PlatformAccountEditSchema>;
export type PlatformAccountStatus = z.infer<typeof PlatformAccountStatusSchema>;
export type PlatformCode = z.infer<typeof PlatformCodeSchema>;

export interface PlatformAccountFilters {
  readonly platformCode?: PlatformCode;
  readonly status?: PlatformAccountStatus;
  readonly workspaceId?: string;
}
