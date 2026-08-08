import { z } from 'zod';

import {
  CursorPageMetaSchema,
  CursorSchema,
  IsoDateTimeSchema,
  RequestMetaSchema,
  UuidSchema,
  VersionSchema,
  createDataResponseSchema,
} from '../common.js';
import { PLATFORM_CODES } from '../../platforms.js';

export const PublishJobParamsSchema = z.object({ id: UuidSchema }).strict();
export const GeneratePublishMediaRequestSchema = z.object({}).strict();
export const ReconcilePublishJobRequestSchema = z.object({}).strict();
export const CreatePublishJobRequestSchema = z
  .object({
    account_id: UuidSchema,
    scheduled_at: IsoDateTimeSchema,
    variant_id: UuidSchema,
  })
  .strict();
export const RetryPublishRequestSchema = z
  .object({ scheduled_at: IsoDateTimeSchema.optional() })
  .strict();
const PublishExternalUrlSchema = z
  .url()
  .max(2_048)
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), {
    message: 'external_url must use HTTP or HTTPS',
  });
export const ResolveUnknownPublishRequestSchema = z.discriminatedUnion('resolution', [
  z
    .object({
      external_post_id: z.string().trim().min(1).max(240).optional(),
      external_url: PublishExternalUrlSchema,
      resolution: z.literal('published'),
    })
    .strict(),
  z.object({ resolution: z.literal('not_published') }).strict(),
]);
export const PublishJobQuerySchema = z
  .object({
    account_id: UuidSchema.optional(),
    cursor: CursorSchema.optional(),
    from: IsoDateTimeSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    platform_code: z.enum(PLATFORM_CODES).optional(),
    status: z
      .enum(['scheduled', 'publishing', 'published', 'failed', 'cancel_requested', 'cancelled'])
      .optional(),
    to: IsoDateTimeSchema.optional(),
    variant_id: UuidSchema.optional(),
    workspace_id: UuidSchema.optional(),
  })
  .strict()
  .refine((value) => !value.from || !value.to || Date.parse(value.from) < Date.parse(value.to), {
    message: 'from must be earlier than to',
    path: ['to'],
  });
export const PublishJobViewSchema = z
  .object({
    account_id: UuidSchema,
    attempt_count: z.number().int().min(0).max(20),
    content_version_id: UuidSchema,
    created_at: IsoDateTimeSchema,
    created_by: UuidSchema,
    external_post_id: z.string().nullable(),
    external_url: z.url().nullable(),
    id: UuidSchema,
    idempotency_key: z.string().min(1).max(160),
    last_error: z.record(z.string(), z.unknown()).nullable(),
    origin: z.enum(['manual', 'official_site_automation', 'baijiahao_automation']),
    payload_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    published_at: IsoDateTimeSchema.nullable(),
    scheduled_at: IsoDateTimeSchema,
    status: z.enum([
      'scheduled',
      'publishing',
      'published',
      'failed',
      'cancel_requested',
      'cancelled',
    ]),
    tenant_id: UuidSchema,
    updated_at: IsoDateTimeSchema,
    variant_id: UuidSchema,
    version: VersionSchema,
  })
  .strict();
export const PublishJobResponseSchema = createDataResponseSchema(PublishJobViewSchema);
export const PublishAttemptViewSchema = z
  .object({
    adapter_code: z.string().trim().min(1).max(80),
    attempt_no: z.number().int().min(1).max(20),
    created_at: IsoDateTimeSchema,
    error_code: z.string().trim().min(1).max(80).nullable(),
    finished_at: IsoDateTimeSchema.nullable(),
    id: UuidSchema,
    publish_job_id: UuidSchema,
    request_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    response: z.record(z.string(), z.unknown()).nullable(),
    started_at: IsoDateTimeSchema,
    status: z.enum(['running', 'succeeded', 'failed', 'unknown']),
    tenant_id: UuidSchema,
  })
  .strict();
export const ExportArtifactViewSchema = z
  .object({
    content_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    content_version_id: UuidSchema,
    created_at: IsoDateTimeSchema,
    created_by: UuidSchema,
    expires_at: IsoDateTimeSchema,
    id: UuidSchema,
    manifest: z.record(z.string(), z.unknown()),
    publish_job_id: UuidSchema.nullable(),
    tenant_id: UuidSchema,
    variant_id: UuidSchema,
  })
  .strict();
export const PublishMediaStateSchema = z
  .object({
    asset_count: z.number().int().nonnegative(),
    run_id: UuidSchema.nullable(),
    status: z.enum(['none', 'queued', 'running', 'ready']),
    supported: z.boolean(),
  })
  .strict();
export const PublishMediaRunSchema = z
  .object({
    id: UuidSchema,
    status: z.enum(['queued', 'running', 'succeeded', 'fallback']),
  })
  .strict();
export const PublishJobDetailSchema = z
  .object({
    attempts: z.array(PublishAttemptViewSchema),
    baijiahao_reconciliation: z
      .object({
        platform_code: z.literal('baijiahao'),
      })
      .strict()
      .nullable(),
    export_artifact: ExportArtifactViewSchema.nullable(),
    job: PublishJobViewSchema,
    media: PublishMediaStateSchema,
    unknown_resolution: z
      .object({
        can_retry: z.boolean(),
        latest_attempt_no: z.number().int().min(1).max(20),
        platform_code: z.literal('baijiahao'),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const SignedDownloadViewSchema = z
  .object({
    artifact_id: UuidSchema,
    content_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    content_version_id: UuidSchema,
    expires_at: IsoDateTimeSchema,
    url: z.url(),
  })
  .strict();
export const PublishJobPageSchema = z
  .object({ data: z.array(PublishJobViewSchema), meta: CursorPageMetaSchema })
  .strict();
export const PublishJobDetailResponseSchema = z
  .object({ data: PublishJobDetailSchema, meta: RequestMetaSchema })
  .strict();
export const PublishMediaRunResponseSchema = createDataResponseSchema(PublishMediaRunSchema);
export const PublishAttemptPageSchema = z
  .object({ data: z.array(PublishAttemptViewSchema), meta: RequestMetaSchema })
  .strict();
export const SignedDownloadResponseSchema = createDataResponseSchema(SignedDownloadViewSchema);

export type CreatePublishJobRequest = z.infer<typeof CreatePublishJobRequestSchema>;
export type ReconcilePublishJobRequest = z.infer<typeof ReconcilePublishJobRequestSchema>;
export type RetryPublishRequest = z.infer<typeof RetryPublishRequestSchema>;
export type ResolveUnknownPublishRequest = z.infer<typeof ResolveUnknownPublishRequestSchema>;
export type PublishJobView = z.infer<typeof PublishJobViewSchema>;
export type PublishJobQuery = z.infer<typeof PublishJobQuerySchema>;
export type PublishAttemptView = z.infer<typeof PublishAttemptViewSchema>;
export type ExportArtifactView = z.infer<typeof ExportArtifactViewSchema>;
export type PublishJobDetail = z.infer<typeof PublishJobDetailSchema>;
export type PublishMediaRun = z.infer<typeof PublishMediaRunSchema>;
export type PublishMediaState = z.infer<typeof PublishMediaStateSchema>;
export type SignedDownloadView = z.infer<typeof SignedDownloadViewSchema>;
