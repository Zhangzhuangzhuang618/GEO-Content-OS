import { z } from 'zod';

import {
  IsoDateTimeSchema,
  UuidSchema,
  VersionSchema,
  createDataResponseSchema,
} from '../common.js';

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

export type CreatePublishJobRequest = z.infer<typeof CreatePublishJobRequestSchema>;
export type RetryPublishRequest = z.infer<typeof RetryPublishRequestSchema>;
export type PublishJobView = z.infer<typeof PublishJobViewSchema>;
