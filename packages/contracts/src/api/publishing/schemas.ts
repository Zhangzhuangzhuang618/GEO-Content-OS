import { z } from 'zod';
import { PLATFORM_CODES } from '../../platforms.js';
import {
  IsoDateTimeSchema,
  UuidSchema,
  VersionSchema,
  createDataResponseSchema,
} from '../common.js';

const CredentialSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => Object.keys(value).length > 0, 'credential must not be empty');
const PublishingUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), {
    message: 'publishing_url must use HTTP or HTTPS',
  });
export const PlatformAccountParamsSchema = z.object({ id: UuidSchema }).strict();
export const CreatePlatformAccountRequestSchema = z
  .object({
    credential: CredentialSchema.optional(),
    display_name: z.string().trim().min(1).max(120),
    platform_code: z.enum(PLATFORM_CODES),
    publishing_url: PublishingUrlSchema.optional(),
    publish_mode: z.enum(['api', 'export', 'manual']),
    timezone: z.string().trim().min(1).max(64),
    workspace_id: UuidSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.publish_mode !== 'api' ||
      value.platform_code === 'baijiahao' ||
      value.platform_code === 'sohu' ||
      value.credential !== undefined,
    {
      message: 'API accounts require credential',
      path: ['credential'],
    },
  );
export const RefreshAccountRequestSchema = z
  .object({ credential: CredentialSchema.optional() })
  .strict();
export const UpdatePlatformAccountRequestSchema = z
  .object({
    credential: CredentialSchema.optional(),
    display_name: z.string().trim().min(1).max(120),
    publishing_url: PublishingUrlSchema.nullable().optional(),
    publish_mode: z.enum(['api', 'export', 'manual']),
    timezone: z.string().trim().min(1).max(64),
  })
  .strict();
export const DisablePlatformAccountRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(1000) })
  .strict();
export const PlatformAccountQuerySchema = z
  .object({
    platform_code: z.enum(PLATFORM_CODES).optional(),
    status: z.enum(['active', 'reauth', 'disabled']).optional(),
    workspace_id: UuidSchema.optional(),
  })
  .strict();
export const PlatformAccountViewSchema = z
  .object({
    capabilities: z.record(z.string(), z.unknown()),
    created_at: IsoDateTimeSchema,
    display_name: z.string(),
    id: UuidSchema,
    platform_code: z.enum(PLATFORM_CODES),
    provider_account_id: z.string().nullable(),
    publishing_url: PublishingUrlSchema.nullable(),
    publish_mode: z.enum(['api', 'export', 'manual']),
    scopes: z.array(z.string()),
    status: z.enum(['active', 'reauth', 'disabled']),
    tenant_id: UuidSchema,
    timezone: z.string(),
    token_expires_at: IsoDateTimeSchema.nullable(),
    updated_at: IsoDateTimeSchema,
    version: VersionSchema,
    workspace_id: UuidSchema,
  })
  .strict();
export const CapabilityViewSchema = z
  .object({
    account_id: UuidSchema,
    capabilities: z.record(z.string(), z.unknown()),
    checked_at: IsoDateTimeSchema,
    publish_mode: z.enum(['api', 'export', 'manual']),
    status: z.enum(['active', 'reauth', 'disabled']),
    version: VersionSchema,
  })
  .strict();
export const PlatformAccountResponseSchema = createDataResponseSchema(PlatformAccountViewSchema);
export const CapabilityResponseSchema = createDataResponseSchema(CapabilityViewSchema);
export const OfficialSiteAutomationPolicyRequestSchema = z
  .object({
    daily_enabled: z.boolean().optional(),
    enabled: z.boolean(),
    expected_version: VersionSchema.optional(),
    project_id: UuidSchema,
  })
  .strict();
export const OfficialSiteDailyBatchRestartRequestSchema = z
  .object({
    expected_batch_version: VersionSchema,
    project_id: UuidSchema,
  })
  .strict();
export const OfficialSiteDailyBatchCancelRequestSchema = z
  .object({
    expected_batch_version: VersionSchema,
    project_id: UuidSchema,
  })
  .strict();
export const OfficialSiteDailyBatchSummarySchema = z
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
    version: VersionSchema,
  })
  .strict();
export const OfficialSiteAutomationPolicyViewSchema = z
  .object({
    account_id: UuidSchema,
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
    id: UuidSchema,
    max_rewrites: z.literal(3),
    platform_fit_min: z.literal(80),
    project_id: UuidSchema,
    publish_attempt_limit: z.literal(3),
    question_coverage_min: z.literal(80),
    readability_safety_min: z.literal(85),
    tenant_id: UuidSchema,
    today_batch: OfficialSiteDailyBatchSummarySchema.nullable(),
    updated_at: IsoDateTimeSchema,
    version: VersionSchema,
    workspace_id: UuidSchema,
  })
  .strict();
export const OfficialSiteAutomationPolicyResponseSchema = createDataResponseSchema(
  OfficialSiteAutomationPolicyViewSchema,
);
export const OfficialSiteAutomationPolicyPageSchema = z
  .object({
    data: z.array(OfficialSiteAutomationPolicyViewSchema),
    meta: z.object({ request_id: z.string().min(1) }).strict(),
  })
  .strict();
const TimeOfDaySchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u);
export const BaijiahaoAutomationPolicyRequestSchema = z
  .object({
    daily_candidate_limit: z.number().int().min(1).max(30),
    daily_enabled: z.boolean(),
    daily_generation_time: TimeOfDaySchema.default('00:30:00'),
    daily_schedule_times: z.array(TimeOfDaySchema).min(1).max(10),
    daily_target_count: z.number().int().min(1).max(10),
    enabled: z.boolean(),
    expected_version: VersionSchema.optional(),
    independent_fallback_enabled: z.boolean().default(false),
    project_id: UuidSchema,
    source_mode: z.enum(['official_site_derived', 'independent']),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.daily_candidate_limit < value.daily_target_count) {
      context.addIssue({
        code: 'custom',
        message: 'daily_candidate_limit must be at least daily_target_count',
        path: ['daily_candidate_limit'],
      });
    }
    if (value.daily_schedule_times.length !== value.daily_target_count) {
      context.addIssue({
        code: 'custom',
        message: 'daily_schedule_times must match daily_target_count',
        path: ['daily_schedule_times'],
      });
    }
    if (value.daily_enabled && !value.enabled) {
      context.addIssue({
        code: 'custom',
        message: 'daily automation requires enabled',
        path: ['daily_enabled'],
      });
    }
    if (value.independent_fallback_enabled && value.source_mode !== 'official_site_derived') {
      context.addIssue({
        code: 'custom',
        message: 'independent fallback only applies to official_site_derived mode',
        path: ['independent_fallback_enabled'],
      });
    }
  });
export const BrowserPlatformAutomationPolicyRequestSchema = z
  .object({
    daily_candidate_limit: z.number().int().min(1).max(30),
    daily_enabled: z.boolean(),
    daily_generation_time: TimeOfDaySchema.default('00:30:00'),
    daily_schedule_times: z.array(TimeOfDaySchema).min(1).max(10),
    daily_target_count: z.number().int().min(1).max(10),
    enabled: z.boolean(),
    expected_version: VersionSchema.optional(),
    project_id: UuidSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.daily_candidate_limit < value.daily_target_count) {
      context.addIssue({
        code: 'custom',
        message: 'daily_candidate_limit must be at least daily_target_count',
        path: ['daily_candidate_limit'],
      });
    }
    if (value.daily_schedule_times.length !== value.daily_target_count) {
      context.addIssue({
        code: 'custom',
        message: 'daily_schedule_times must match daily_target_count',
        path: ['daily_schedule_times'],
      });
    }
    if (value.daily_enabled && !value.enabled) {
      context.addIssue({
        code: 'custom',
        message: 'daily automation requires enabled',
        path: ['daily_enabled'],
      });
    }
  });
export const BaijiahaoDailyBatchSummarySchema = z
  .object({
    active_items: z
      .array(
        z
          .object({
            automation_run_id: UuidSchema,
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
            updated_at: IsoDateTimeSchema,
          })
          .strict(),
      )
      .max(30)
      .default([]),
    attempted_count: z.number().int().min(0).max(30),
    business_date: z.iso.date(),
    in_progress_count: z.number().int().min(0).max(30),
    last_activity_at: IsoDateTimeSchema,
    last_error_message: z.string().nullable(),
    manual_items: z
      .array(
        z
          .object({
            automation_run_id: UuidSchema,
            candidate_no: z.number().int().min(1).max(30),
            content_version_id: UuidSchema.nullable(),
            last_error: z.record(z.string(), z.unknown()).nullable(),
            package_id: UuidSchema.nullable(),
            publish_job_id: UuidSchema.nullable(),
            quality_report_id: UuidSchema.nullable(),
            rewrite_count: z.number().int().min(0).max(3),
            source_mode: z.enum(['official_site_derived', 'independent']),
            title: z.string().trim().min(1).max(240).nullable(),
            updated_at: IsoDateTimeSchema,
            variant_id: UuidSchema.nullable(),
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
    version: VersionSchema,
  })
  .strict();
export const BaijiahaoBrowserSessionViewSchema = z
  .object({
    account_id: UuidSchema,
    authenticated_at: IsoDateTimeSchema.nullable(),
    last_verified_at: IsoDateTimeSchema.nullable(),
    qr_expires_at: IsoDateTimeSchema.nullable(),
    status: z.enum([
      'login_required',
      'qr_ready',
      'authenticated',
      'reauth',
      'attention_required',
      'disabled',
    ]),
    version: VersionSchema,
  })
  .strict();
export const BaijiahaoBrowserLoginViewSchema = BaijiahaoBrowserSessionViewSchema.extend({
  captcha_image_data_url: z
    .string()
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u)
    .optional(),
  login_stage: z.enum(['captcha_required', 'sms_code_required']).optional(),
  qr_image_data_url: z
    .string()
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u)
    .optional(),
}).strict();
const LoginIdentifierSchema = z.string().trim().min(1).max(120);
const LoginPasswordSchema = z.string().min(1).max(256);
const MainlandMobileSchema = z.string().regex(/^1[3-9][0-9]{9}$/u);
export const SohuBrowserLoginRequestSchema = z
  .discriminatedUnion('method', [
    z.object({ method: z.literal('wechat') }).strict(),
    z
      .object({
        accepted_terms: z.literal(true),
        account: LoginIdentifierSchema,
        method: z.literal('password'),
        password: LoginPasswordSchema,
      })
      .strict(),
    z.object({ method: z.literal('sms_prepare'), mobile: MainlandMobileSchema }).strict(),
    z
      .object({
        accepted_terms: z.literal(true),
        image_captcha: z.string().trim().min(1).max(12),
        method: z.literal('sms_send'),
        mobile: MainlandMobileSchema,
      })
      .strict(),
    z
      .object({
        accepted_terms: z.literal(true),
        method: z.literal('sms_verify'),
        mobile: MainlandMobileSchema,
        sms_code: z
          .string()
          .trim()
          .regex(/^[0-9]{4,8}$/u),
      })
      .strict(),
  ])
  .default({ method: 'wechat' });
export const LiejuBrowserLoginRequestSchema = z
  .discriminatedUnion('method', [
    z.object({ method: z.literal('qq') }).strict(),
    z
      .object({
        method: z.literal('password'),
        password: LoginPasswordSchema,
        username: LoginIdentifierSchema,
      })
      .strict(),
  ])
  .default({ method: 'qq' });
export const BaijiahaoAutomationPolicyViewSchema = z
  .object({
    account_id: UuidSchema,
    brand_consistency_min: z.literal(90),
    browser_session: BaijiahaoBrowserSessionViewSchema.nullable(),
    daily_candidate_limit: z.number().int().min(1).max(30),
    daily_enabled: z.boolean(),
    daily_generation_time: TimeOfDaySchema,
    daily_schedule_times: z.array(TimeOfDaySchema).min(1).max(10),
    daily_target_count: z.number().int().min(1).max(10),
    daily_timezone: z.literal('Asia/Shanghai'),
    enabled: z.boolean(),
    factual_accuracy_min: z.literal(90),
    geo_total_min: z.literal(85),
    id: UuidSchema,
    independent_fallback_enabled: z.boolean(),
    max_rewrites: z.literal(3),
    max_source_similarity: z.literal(0.82),
    platform_fit_min: z.literal(80),
    project_id: UuidSchema,
    publish_attempt_limit: z.literal(3),
    question_coverage_min: z.literal(80),
    readability_safety_min: z.literal(85),
    source_mode: z.enum(['official_site_derived', 'independent']),
    tenant_id: UuidSchema,
    today_batch: BaijiahaoDailyBatchSummarySchema.nullable(),
    updated_at: IsoDateTimeSchema,
    version: VersionSchema,
    workspace_id: UuidSchema,
  })
  .strict()
  .refine((value) => value.daily_schedule_times.length === value.daily_target_count, {
    message: 'daily schedule count must match target count',
    path: ['daily_schedule_times'],
  });
export const BrowserPlatformDailyBatchSummarySchema = z
  .object({
    attempted_count: z.number().int().min(0).max(30),
    business_date: z.iso.date(),
    in_progress_count: z.number().int().min(0).max(30),
    last_error_message: z.string().nullable(),
    manual_items: z
      .array(
        z
          .object({
            automation_run_id: UuidSchema,
            candidate_no: z.number().int().min(1).max(30),
            content_version_id: UuidSchema.nullable(),
            last_error: z.record(z.string(), z.unknown()).nullable(),
            package_id: UuidSchema,
            publish_job_id: UuidSchema.nullable(),
            quality_report_id: UuidSchema.nullable(),
            rewrite_count: z.number().int().min(0).max(3),
            title: z.string().trim().min(1).max(240).nullable(),
            updated_at: IsoDateTimeSchema,
            variant_id: UuidSchema,
          })
          .strict(),
      )
      .max(30)
      .default([]),
    manual_required_count: z.number().int().min(0).max(30),
    published_count: z.number().int().min(0).max(10),
    retired_count: z.number().int().min(0).max(30),
    scheduled_count: z.number().int().min(0).max(10),
    status: z.enum(['running', 'scheduled', 'completed', 'attention_required', 'cancelled']),
    target_count: z.number().int().min(1).max(10),
    version: VersionSchema,
  })
  .strict();
export const BrowserPlatformAutomationPolicyViewSchema = z
  .object({
    account_id: UuidSchema,
    brand_consistency_min: z.literal(90),
    daily_candidate_limit: z.number().int().min(1).max(30),
    daily_enabled: z.boolean(),
    daily_generation_time: TimeOfDaySchema,
    daily_schedule_times: z.array(TimeOfDaySchema).min(1).max(10),
    daily_target_count: z.number().int().min(1).max(10),
    daily_timezone: z.literal('Asia/Shanghai'),
    enabled: z.boolean(),
    factual_accuracy_min: z.literal(90),
    geo_total_min: z.literal(85),
    id: UuidSchema,
    max_rewrites: z.literal(3),
    platform_code: z.enum(['sohu', 'lieju']),
    platform_fit_min: z.literal(80),
    project_id: UuidSchema,
    publish_attempt_limit: z.literal(3),
    question_coverage_min: z.literal(80),
    readability_safety_min: z.literal(85),
    tenant_id: UuidSchema,
    today_batch: BrowserPlatformDailyBatchSummarySchema.nullable(),
    updated_at: IsoDateTimeSchema,
    version: VersionSchema,
    workspace_id: UuidSchema,
  })
  .strict()
  .refine((value) => value.daily_schedule_times.length === value.daily_target_count, {
    message: 'daily schedule count must match target count',
    path: ['daily_schedule_times'],
  });
export const BrowserPlatformAutomationPolicyResponseSchema = createDataResponseSchema(
  BrowserPlatformAutomationPolicyViewSchema,
);
export const BrowserPlatformAutomationPolicyPageSchema = z
  .object({
    data: z.array(BrowserPlatformAutomationPolicyViewSchema),
    meta: z.object({ request_id: z.string().min(1) }).strict(),
  })
  .strict();
export const BaijiahaoAutomationPolicyResponseSchema = createDataResponseSchema(
  BaijiahaoAutomationPolicyViewSchema,
);
export const BaijiahaoAutomationPolicyPageSchema = z
  .object({
    data: z.array(BaijiahaoAutomationPolicyViewSchema),
    meta: z.object({ request_id: z.string().min(1) }).strict(),
  })
  .strict();
export const BaijiahaoBrowserSessionResponseSchema = createDataResponseSchema(
  BaijiahaoBrowserSessionViewSchema,
);
export const BaijiahaoBrowserLoginResponseSchema = createDataResponseSchema(
  BaijiahaoBrowserLoginViewSchema,
);
export const PlatformAccountPageSchema = z
  .object({
    data: z.array(PlatformAccountViewSchema),
    meta: z.object({ request_id: z.string().min(1) }).strict(),
  })
  .strict();
export type CreatePlatformAccountRequest = z.infer<typeof CreatePlatformAccountRequestSchema>;
export type RefreshAccountRequest = z.infer<typeof RefreshAccountRequestSchema>;
export type UpdatePlatformAccountRequest = z.infer<typeof UpdatePlatformAccountRequestSchema>;
export type PlatformAccountView = z.infer<typeof PlatformAccountViewSchema>;
export type OfficialSiteAutomationPolicyRequest = z.infer<
  typeof OfficialSiteAutomationPolicyRequestSchema
>;
export type OfficialSiteDailyBatchRestartRequest = z.infer<
  typeof OfficialSiteDailyBatchRestartRequestSchema
>;
export type OfficialSiteDailyBatchCancelRequest = z.infer<
  typeof OfficialSiteDailyBatchCancelRequestSchema
>;
export type OfficialSiteAutomationPolicyView = z.infer<
  typeof OfficialSiteAutomationPolicyViewSchema
>;
export type BaijiahaoAutomationPolicyRequest = z.infer<
  typeof BaijiahaoAutomationPolicyRequestSchema
>;
export type BaijiahaoAutomationPolicyView = z.infer<typeof BaijiahaoAutomationPolicyViewSchema>;
export type BrowserPlatformAutomationPolicyRequest = z.infer<
  typeof BrowserPlatformAutomationPolicyRequestSchema
>;
export type BrowserPlatformAutomationPolicyView = z.infer<
  typeof BrowserPlatformAutomationPolicyViewSchema
>;
export type BaijiahaoBrowserSessionView = z.infer<typeof BaijiahaoBrowserSessionViewSchema>;
export type BaijiahaoBrowserLoginView = z.infer<typeof BaijiahaoBrowserLoginViewSchema>;
export type SohuBrowserLoginRequest = z.infer<typeof SohuBrowserLoginRequestSchema>;
export type LiejuBrowserLoginRequest = z.infer<typeof LiejuBrowserLoginRequestSchema>;
