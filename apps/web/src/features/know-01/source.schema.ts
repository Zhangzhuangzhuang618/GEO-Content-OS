import { z } from 'zod';

export const SourceViewSchema = z
  .object({
    content_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    created_at: z.iso.datetime(),
    created_by: z.string().uuid(),
    effective_from: z.iso.date().nullable(),
    effective_to: z.iso.date().nullable(),
    id: z.string().uuid(),
    language: z.string().min(1),
    mime_type: z.string().min(1),
    project_id: z.string().uuid().nullable(),
    source_type: z.enum(['pdf', 'docx', 'txt', 'url', 'image']),
    status: z.enum(['processing', 'active', 'expired', 'failed']),
    tenant_id: z.string().uuid(),
    title: z.string().min(1),
    trust_level: z.enum(['verified', 'normal', 'untrusted']),
    updated_at: z.iso.datetime(),
    workspace_id: z.string().uuid(),
  })
  .strict();

export const SourcePageSchema = z
  .object({
    data: z.array(SourceViewSchema),
    meta: z.object({ next_cursor: z.string().nullable(), request_id: z.string().min(1) }).strict(),
  })
  .strict();

export const SourceDetailSchema = z
  .object({
    data: z
      .object({
        ingest_jobs: z.array(
          z
            .object({
              finished_at: z.iso.datetime().nullable(),
              status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
            })
            .passthrough(),
        ),
        source: SourceViewSchema,
      })
      .passthrough(),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export type SourceView = z.infer<typeof SourceViewSchema>;
export type SourceStatus = SourceView['status'];
export type SourceType = SourceView['source_type'];
export type TrustLevel = SourceView['trust_level'];
export interface SourceListItem extends SourceView {
  readonly parsed_at: string | null;
}
