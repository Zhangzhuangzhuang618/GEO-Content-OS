import { z } from 'zod';

import { ContentVariantSchema } from '../cont-03/content-package-list.schema';
import type { PlatformCode } from '../pub-01/platform-account.schema';

export const PublishJobStatusSchema = z.enum([
  'scheduled',
  'publishing',
  'published',
  'failed',
  'cancel_requested',
  'cancelled',
]);

export const PublishJobSchema = z
  .object({
    account_id: z.string().uuid(),
    attempt_count: z.number().int().min(0).max(20),
    content_version_id: z.string().uuid(),
    created_at: z.iso.datetime(),
    created_by: z.string().uuid(),
    external_post_id: z.string().nullable(),
    external_url: z.url().nullable(),
    id: z.string().uuid(),
    idempotency_key: z.string().min(1).max(160),
    last_error: z.record(z.string(), z.unknown()).nullable(),
    payload_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    scheduled_at: z.iso.datetime(),
    status: PublishJobStatusSchema,
    tenant_id: z.string().uuid(),
    updated_at: z.iso.datetime(),
    variant_id: z.string().uuid(),
    version: z.number().int().positive(),
  })
  .strict();

const ResponseMetaSchema = z.object({ request_id: z.string().min(1) }).passthrough();

export const PublishJobPageSchema = z
  .object({
    data: z.array(PublishJobSchema),
    meta: z.object({ next_cursor: z.string().nullable(), request_id: z.string().min(1) }).strict(),
  })
  .strict();

export const PublishJobResponseSchema = z
  .object({ data: PublishJobSchema, meta: ResponseMetaSchema })
  .strict();

export const SchedulableVariantResponseSchema = z
  .object({
    data: z.object({ variant: ContentVariantSchema }).passthrough(),
    meta: ResponseMetaSchema,
  })
  .strict();

export interface PublishingCalendarFilters {
  readonly accountId?: string;
  readonly from?: string;
  readonly platformCode?: PlatformCode;
  readonly status?: z.infer<typeof PublishJobStatusSchema>;
  readonly to?: string;
  readonly workspaceId?: string;
}

export type PublishJob = z.infer<typeof PublishJobSchema>;
export type PublishJobStatus = z.infer<typeof PublishJobStatusSchema>;
