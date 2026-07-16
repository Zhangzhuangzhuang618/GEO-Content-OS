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
    payload_hash: z.string().regex(/^[0-9a-f]{64}$/u),
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
export const PublishJobDetailSchema = z
  .object({
    attempts: z.array(PublishAttemptViewSchema),
    export_artifact: ExportArtifactViewSchema.nullable(),
    job: PublishJobViewSchema,
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
export const PublishAttemptPageSchema = z
  .object({ data: z.array(PublishAttemptViewSchema), meta: RequestMetaSchema })
  .strict();
export const SignedDownloadResponseSchema = createDataResponseSchema(SignedDownloadViewSchema);

export type CreatePublishJobRequest = z.infer<typeof CreatePublishJobRequestSchema>;
export type RetryPublishRequest = z.infer<typeof RetryPublishRequestSchema>;
export type PublishJobView = z.infer<typeof PublishJobViewSchema>;
export type PublishJobQuery = z.infer<typeof PublishJobQuerySchema>;
export type PublishAttemptView = z.infer<typeof PublishAttemptViewSchema>;
export type ExportArtifactView = z.infer<typeof ExportArtifactViewSchema>;
export type PublishJobDetail = z.infer<typeof PublishJobDetailSchema>;
export type SignedDownloadView = z.infer<typeof SignedDownloadViewSchema>;
