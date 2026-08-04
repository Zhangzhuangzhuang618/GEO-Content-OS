import { z } from 'zod';

import { PublishJobSchema } from '../pub-02/publishing-calendar.schema';

export const PublishAttemptSchema = z
  .object({
    adapter_code: z.string().min(1).max(80),
    attempt_no: z.number().int().min(1).max(20),
    created_at: z.iso.datetime(),
    error_code: z.string().min(1).max(80).nullable(),
    finished_at: z.iso.datetime().nullable(),
    id: z.string().uuid(),
    publish_job_id: z.string().uuid(),
    request_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    response: z.record(z.string(), z.unknown()).nullable(),
    started_at: z.iso.datetime(),
    status: z.enum(['running', 'succeeded', 'failed', 'unknown']),
    tenant_id: z.string().uuid(),
  })
  .strict();

export const ExportArtifactSchema = z
  .object({
    content_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    content_version_id: z.string().uuid(),
    created_at: z.iso.datetime(),
    created_by: z.string().uuid(),
    expires_at: z.iso.datetime(),
    id: z.string().uuid(),
    manifest: z.record(z.string(), z.unknown()),
    publish_job_id: z.string().uuid().nullable(),
    tenant_id: z.string().uuid(),
    variant_id: z.string().uuid(),
  })
  .strict();

const ResponseMetaSchema = z.object({ request_id: z.string().min(1) }).passthrough();

export const PublishMediaStateSchema = z
  .object({
    asset_count: z.number().int().nonnegative(),
    run_id: z.string().uuid().nullable(),
    status: z.enum(['none', 'queued', 'running', 'ready']),
    supported: z.boolean(),
  })
  .strict();

export const PublishJobDetailResponseSchema = z
  .object({
    data: z
      .object({
        attempts: z.array(PublishAttemptSchema),
        export_artifact: ExportArtifactSchema.nullable(),
        job: PublishJobSchema,
        media: PublishMediaStateSchema,
      })
      .strict(),
    meta: ResponseMetaSchema,
  })
  .strict();

export const PublishJobResponseSchema = z
  .object({ data: PublishJobSchema, meta: ResponseMetaSchema })
  .strict();

export const PublishMediaRunResponseSchema = z
  .object({
    data: z
      .object({
        id: z.string().uuid(),
        status: z.enum(['queued', 'running', 'succeeded', 'fallback']),
      })
      .strict(),
    meta: ResponseMetaSchema,
  })
  .strict();

export const SignedDownloadResponseSchema = z
  .object({
    data: z
      .object({
        artifact_id: z.string().uuid(),
        content_hash: z.string().regex(/^[0-9a-f]{64}$/u),
        content_version_id: z.string().uuid(),
        expires_at: z.iso.datetime(),
        url: z.url(),
      })
      .strict(),
    meta: ResponseMetaSchema,
  })
  .strict();

export type PublishAttempt = z.infer<typeof PublishAttemptSchema>;
export type ExportArtifact = z.infer<typeof ExportArtifactSchema>;
export type PublishJobDetail = z.infer<typeof PublishJobDetailResponseSchema>['data'];
export type SignedDownload = z.infer<typeof SignedDownloadResponseSchema>['data'];
