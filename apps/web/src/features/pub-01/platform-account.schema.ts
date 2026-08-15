import { z } from 'zod';

export const PlatformCodeSchema = z.enum([
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

export const OfficialSiteAutomationPolicySchema = z
  .object({
    account_id: z.string().uuid(),
    brand_consistency_min: z.literal(90),
    daily_candidate_limit: z.literal(30),
    daily_enabled: z.boolean(),
    daily_generation_time: z.literal('00:00:00'),
    daily_schedule_times: z.tuple([
      z.literal('08:00:00'),
      z.literal('09:30:00'),
      z.literal('11:00:00'),
      z.literal('12:30:00'),
      z.literal('14:00:00'),
      z.literal('15:30:00'),
      z.literal('17:00:00'),
      z.literal('18:30:00'),
      z.literal('20:00:00'),
      z.literal('21:30:00'),
    ]),
    daily_target_count: z.literal(10),
    daily_timezone: z.literal('Asia/Shanghai'),
    enabled: z.boolean(),
    factual_accuracy_min: z.literal(90),
    geo_total_min: z.literal(85),
    id: z.string().uuid(),
    max_rewrites: z.literal(3),
    platform_fit_min: z.literal(80),
    project_id: z.string().uuid(),
    publish_attempt_limit: z.literal(3),
    question_coverage_min: z.literal(80),
    readability_safety_min: z.literal(85),
    tenant_id: z.string().uuid(),
    today_batch: z
      .object({
        attempt_no: z.number().int().positive(),
        attempted_count: z.number().int().min(0).max(30),
        business_date: z.iso.date(),
        in_progress_count: z.number().int().min(0).max(30),
        last_error_message: z.string().nullable(),
        published_count: z.number().int().min(0).max(10),
        queued_count: z.number().int().min(0).max(30),
        qualified_count: z.number().int().min(0).max(30),
        restart_allowed: z.boolean(),
        retired_count: z.number().int().min(0).max(30),
        running_count: z.number().int().min(0).max(30),
        scheduled_count: z.number().int().min(0).max(10),
        status: z.enum(['running', 'scheduled', 'completed', 'attention_required', 'cancelled']),
        target_count: z.literal(10),
        version: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    updated_at: z.iso.datetime(),
    version: z.number().int().positive(),
    workspace_id: z.string().uuid(),
  })
  .strict();
export const OfficialSiteAutomationPolicyPageSchema = z
  .object({ data: z.array(OfficialSiteAutomationPolicySchema), meta: ResponseMetaSchema })
  .strict();
export const OfficialSiteAutomationPolicyResponseSchema = z
  .object({ data: OfficialSiteAutomationPolicySchema, meta: ResponseMetaSchema })
  .strict();

export const BaijiahaoBrowserSessionSchema = z
  .object({
    account_id: z.string().uuid(),
    authenticated_at: z.iso.datetime().nullable(),
    last_verified_at: z.iso.datetime().nullable(),
    qr_expires_at: z.iso.datetime().nullable(),
    status: z.enum([
      'login_required',
      'qr_ready',
      'authenticated',
      'reauth',
      'attention_required',
      'disabled',
    ]),
    version: z.number().int().positive(),
  })
  .strict();
export const BaijiahaoBrowserLoginSchema = BaijiahaoBrowserSessionSchema.extend({
  captcha_image_data_url: z.string().startsWith('data:image/png;base64,').optional(),
  login_stage: z.enum(['captcha_required', 'sms_code_required']).optional(),
  qr_image_data_url: z.string().startsWith('data:image/png;base64,').optional(),
}).strict();
export const BaijiahaoAutomationPolicySchema = z
  .object({
    account_id: z.string().uuid(),
    brand_consistency_min: z.literal(90),
    browser_session: BaijiahaoBrowserSessionSchema.nullable(),
    daily_candidate_limit: z.number().int().min(1).max(30),
    daily_enabled: z.boolean(),
    daily_generation_time: z.string(),
    daily_schedule_times: z.array(z.string()).min(1).max(10),
    daily_target_count: z.number().int().min(1).max(10),
    daily_timezone: z.literal('Asia/Shanghai'),
    enabled: z.boolean(),
    factual_accuracy_min: z.literal(90),
    geo_total_min: z.literal(85),
    id: z.string().uuid(),
    independent_fallback_enabled: z.boolean(),
    max_rewrites: z.literal(3),
    max_source_similarity: z.literal(0.82),
    platform_fit_min: z.literal(80),
    project_id: z.string().uuid(),
    publish_attempt_limit: z.literal(3),
    question_coverage_min: z.literal(80),
    readability_safety_min: z.literal(85),
    source_mode: z.enum(['official_site_derived', 'independent']),
    tenant_id: z.string().uuid(),
    today_batch: z
      .object({
        active_items: z
          .array(
            z
              .object({
                automation_run_id: z.string().uuid(),
                candidate_no: z.number().int().min(1).max(30),
                item_status: z.enum([
                  'pending',
                  'adapting',
                  'generating',
                  'quality_check',
                  'rewriting',
                  'media_pending',
                  'qualified',
                  'processing',
                ]),
                run_status: z.enum([
                  'generation_pending',
                  'generating',
                  'adaptation_pending',
                  'adapting',
                  'quality_pending',
                  'rewrite_pending',
                  'rewriting',
                  'media_pending',
                  'publish_pending',
                  'scheduled',
                  'publishing',
                  'processing',
                  'published',
                  'skipped',
                  'manual_required',
                  'publish_failed',
                  'disabled',
                ]),
                title: z.string().trim().min(1).max(240).nullable(),
                updated_at: z.iso.datetime(),
              })
              .strict(),
          )
          .max(30)
          .default([]),
        attempted_count: z.number().int().min(0).max(30),
        business_date: z.iso.date(),
        in_progress_count: z.number().int().min(0).max(30),
        last_activity_at: z.iso.datetime(),
        last_error_message: z.string().nullable(),
        manual_items: z
          .array(
            z
              .object({
                automation_run_id: z.string().uuid(),
                candidate_no: z.number().int().min(1).max(30),
                content_version_id: z.string().uuid().nullable(),
                last_error: z.record(z.string(), z.unknown()).nullable(),
                package_id: z.string().uuid().nullable(),
                publish_job_id: z.string().uuid().nullable(),
                quality_report_id: z.string().uuid().nullable(),
                rewrite_count: z.number().int().min(0).max(3),
                source_mode: z.enum(['official_site_derived', 'independent']),
                title: z.string().trim().min(1).max(240).nullable(),
                updated_at: z.iso.datetime(),
                variant_id: z.string().uuid().nullable(),
              })
              .strict(),
          )
          .max(30)
          .default([]),
        manual_required_count: z.number().int().min(0).max(30),
        published_count: z.number().int().min(0).max(10),
        retired_count: z.number().int().min(0).max(30),
        scheduled_count: z.number().int().min(0).max(10),
        skipped_count: z.number().int().min(0).max(30),
        status: z.enum(['running', 'scheduled', 'completed', 'attention_required', 'cancelled']),
        target_count: z.number().int().min(1).max(10),
        version: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    updated_at: z.iso.datetime(),
    version: z.number().int().positive(),
    workspace_id: z.string().uuid(),
  })
  .strict();
export const BrowserPlatformAutomationPolicySchema = z
  .object({
    account_id: z.string().uuid(),
    brand_consistency_min: z.literal(90),
    daily_candidate_limit: z.number().int().min(1).max(30),
    daily_enabled: z.boolean(),
    daily_generation_time: z.string(),
    daily_schedule_times: z.array(z.string()).min(1).max(10),
    daily_target_count: z.number().int().min(1).max(10),
    daily_timezone: z.literal('Asia/Shanghai'),
    enabled: z.boolean(),
    factual_accuracy_min: z.literal(90),
    geo_total_min: z.literal(85),
    id: z.string().uuid(),
    max_rewrites: z.literal(3),
    platform_code: z.enum(['sohu', 'lieju']),
    platform_fit_min: z.literal(80),
    project_id: z.string().uuid(),
    publish_attempt_limit: z.literal(3),
    question_coverage_min: z.literal(80),
    readability_safety_min: z.literal(85),
    tenant_id: z.string().uuid(),
    today_batch: z
      .object({
        attempted_count: z.number().int().min(0).max(30),
        business_date: z.iso.date(),
        in_progress_count: z.number().int().min(0).max(30),
        last_error_message: z.string().nullable(),
        manual_required_count: z.number().int().min(0).max(30),
        published_count: z.number().int().min(0).max(10),
        retired_count: z.number().int().min(0).max(30),
        scheduled_count: z.number().int().min(0).max(10),
        status: z.enum(['running', 'scheduled', 'completed', 'attention_required', 'cancelled']),
        target_count: z.number().int().min(1).max(10),
        version: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    updated_at: z.iso.datetime(),
    version: z.number().int().positive(),
    workspace_id: z.string().uuid(),
  })
  .strict();
export const BrowserPlatformAutomationPolicyPageSchema = z
  .object({ data: z.array(BrowserPlatformAutomationPolicySchema), meta: ResponseMetaSchema })
  .strict();
export const BrowserPlatformAutomationPolicyResponseSchema = z
  .object({ data: BrowserPlatformAutomationPolicySchema, meta: ResponseMetaSchema })
  .strict();
export const BaijiahaoAutomationPolicyPageSchema = z
  .object({ data: z.array(BaijiahaoAutomationPolicySchema), meta: ResponseMetaSchema })
  .strict();
export const BaijiahaoAutomationPolicyResponseSchema = z
  .object({ data: BaijiahaoAutomationPolicySchema, meta: ResponseMetaSchema })
  .strict();
export const BaijiahaoBrowserSessionResponseSchema = z
  .object({ data: BaijiahaoBrowserSessionSchema, meta: ResponseMetaSchema })
  .strict();
export const BaijiahaoBrowserLoginResponseSchema = z
  .object({ data: BaijiahaoBrowserLoginSchema, meta: ResponseMetaSchema })
  .strict();

export const PlatformAccountFormSchema = z
  .object({
    address: z.string(),
    base_url: z.string(),
    bearer_token: z.string(),
    category_id: z.string(),
    contact_name: z.string(),
    display_name: z.string().trim().min(1, '请填写账号名称。').max(120),
    mobile_phone: z.string(),
    platform_code: PlatformCodeSchema,
    publishing_url: z.string(),
    publish_mode: z.enum(['api', 'export', 'manual']),
    qq: z.string(),
    street_id: z.string(),
    timezone: z.string().trim().min(1, '请填写 IANA 时区。').max(64),
    wechat: z.string(),
    workspace_id: z.string().uuid('请选择有效工作区。'),
    zone_id: z.string(),
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
    if (value.platform_code === 'baijiahao' || value.platform_code === 'sohu') return;
    if (value.platform_code === 'lieju') {
      const required = [
        ['address', value.address],
        ['category_id', value.category_id],
        ['contact_name', value.contact_name],
        ['mobile_phone', value.mobile_phone],
        ['zone_id', value.zone_id],
      ] as const;
      for (const [field, fieldValue] of required) {
        if (!fieldValue.trim()) {
          context.addIssue({
            code: 'custom',
            message: '请完整填写列举网发布配置。',
            path: [field],
          });
        }
      }
      if (value.contact_name.trim().length > 25 || value.mobile_phone.trim().length > 20) {
        context.addIssue({
          code: 'custom',
          message: '列举网联系方式超出长度限制。',
          path: ['mobile_phone'],
        });
      }
      return;
    }
    if (!isValidApiBaseUrl(value.base_url.trim())) {
      context.addIssue({
        code: 'custom',
        message: '请输入有效的 HTTPS API 地址；本机联调可使用 localhost。',
        path: ['base_url'],
      });
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
    if (!isValidApiBaseUrl(baseUrl)) {
      context.addIssue({
        code: 'custom',
        message: '更新连接时请输入有效的 HTTPS API 地址；本机联调可使用 localhost。',
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

function isValidApiBaseUrl(value: string) {
  const parsed = z.url().safeParse(value);
  if (!parsed.success) return false;
  const url = new URL(parsed.data);
  if (url.protocol === 'https:') return true;
  return (
    url.protocol === 'http:' &&
    [
      'localhost',
      '127.0.0.1',
      '::1',
      'baijiahao-browser',
      'sohu-browser',
      'lieju-browser',
    ].includes(url.hostname.toLocaleLowerCase('en-US'))
  );
}

export type PlatformAccount = z.infer<typeof PlatformAccountSchema>;
export type PlatformAccountForm = z.infer<typeof PlatformAccountFormSchema>;
export type PlatformAccountEdit = z.infer<typeof PlatformAccountEditSchema>;
export type PlatformAccountStatus = z.infer<typeof PlatformAccountStatusSchema>;
export type PlatformCode = z.infer<typeof PlatformCodeSchema>;
export type OfficialSiteAutomationPolicy = z.infer<typeof OfficialSiteAutomationPolicySchema>;
export type BaijiahaoAutomationPolicy = z.infer<typeof BaijiahaoAutomationPolicySchema>;
export type BrowserPlatformAutomationPolicy = z.infer<typeof BrowserPlatformAutomationPolicySchema>;
export type BaijiahaoBrowserSession = z.infer<typeof BaijiahaoBrowserSessionSchema>;
export type BaijiahaoBrowserLogin = z.infer<typeof BaijiahaoBrowserLoginSchema>;
export type SohuBrowserLoginInput =
  | { readonly method: 'wechat' }
  | {
      readonly accepted_terms: true;
      readonly account: string;
      readonly method: 'password';
      readonly password: string;
    }
  | { readonly method: 'sms_prepare'; readonly mobile: string }
  | {
      readonly accepted_terms: true;
      readonly image_captcha: string;
      readonly method: 'sms_send';
      readonly mobile: string;
    }
  | {
      readonly accepted_terms: true;
      readonly method: 'sms_verify';
      readonly mobile: string;
      readonly sms_code: string;
    };
export type LiejuBrowserLoginInput =
  | { readonly method: 'qq' }
  | { readonly method: 'password'; readonly password: string; readonly username: string };

export interface PlatformAccountFilters {
  readonly platformCode?: PlatformCode;
  readonly status?: PlatformAccountStatus;
  readonly workspaceId?: string;
}
