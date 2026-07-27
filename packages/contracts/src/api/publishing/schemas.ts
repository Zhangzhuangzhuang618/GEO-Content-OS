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
  .refine((value) => value.publish_mode !== 'api' || value.credential !== undefined, {
    message: 'API accounts require credential',
    path: ['credential'],
  });
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
export const OfficialSiteDailyBatchSummarySchema = z
  .object({
    attempted_count: z.number().int().min(0).max(30),
    business_date: z.iso.date(),
    in_progress_count: z.number().int().min(0).max(30),
    last_error_message: z.string().nullable(),
    published_count: z.number().int().min(0).max(10),
    qualified_count: z.number().int().min(0).max(30),
    retired_count: z.number().int().min(0).max(30),
    scheduled_count: z.number().int().min(0).max(10),
    status: z.enum(['running', 'scheduled', 'completed', 'attention_required', 'cancelled']),
    target_count: z.literal(10),
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
export type OfficialSiteAutomationPolicyView = z.infer<
  typeof OfficialSiteAutomationPolicyViewSchema
>;
