import { z } from 'zod';

import {
  CursorPageMetaSchema,
  CursorSchema,
  IsoDateTimeSchema,
  RequestMetaSchema,
  UuidSchema,
} from '../common.js';

const IsoDateSchema = z.string().date();
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const LanguageSchema = z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u);

export const SourceIdSchema = UuidSchema;
export const IngestJobIdSchema = UuidSchema;
export const FactIdSchema = UuidSchema;

export const SourceCreateSchema = z
  .object({
    effective_from: IsoDateSchema.nullable().optional(),
    effective_to: IsoDateSchema.nullable().optional(),
    file: z.unknown().optional(),
    language: LanguageSchema.default('zh-CN'),
    project_id: UuidSchema.nullable().optional(),
    title: z.string().trim().min(1).max(240),
    trust_level: z.enum(['verified', 'normal', 'untrusted']).default('normal'),
    url: z.string().url().max(2_048).optional(),
    workspace_id: UuidSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Number(value.file !== undefined) + Number(value.url !== undefined) !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'Exactly one file or url is required',
        path: ['file'],
      });
    }
    if (value.effective_from && value.effective_to && value.effective_to < value.effective_from) {
      context.addIssue({
        code: 'custom',
        message: 'effective_to must be on or after effective_from',
        path: ['effective_to'],
      });
    }
  });

export const SourceScopeQuerySchema = z
  .object({
    project_id: UuidSchema,
    workspace_id: UuidSchema,
  })
  .strict();

export const SourceListQuerySchema = SourceScopeQuerySchema.extend({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).max(240).optional(),
  source_type: z.enum(['pdf', 'docx', 'txt', 'url', 'image']).optional(),
  status: z.enum(['processing', 'active', 'expired', 'failed']).optional(),
  trust_level: z.enum(['verified', 'normal', 'untrusted']).optional(),
}).strict();

export const ReindexRequestSchema = z
  .object({
    expected_content_hash: Sha256Schema,
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const SourceViewSchema = z
  .object({
    content_hash: Sha256Schema,
    created_at: IsoDateTimeSchema,
    created_by: UuidSchema,
    effective_from: IsoDateSchema.nullable(),
    effective_to: IsoDateSchema.nullable(),
    id: UuidSchema,
    language: LanguageSchema,
    mime_type: z.string().trim().min(1).max(120),
    project_id: UuidSchema.nullable(),
    source_type: z.enum(['pdf', 'docx', 'txt', 'url', 'image']),
    status: z.enum(['processing', 'active', 'expired', 'failed']),
    tenant_id: UuidSchema,
    title: z.string().trim().min(1).max(240),
    trust_level: z.enum(['verified', 'normal', 'untrusted']),
    updated_at: IsoDateTimeSchema,
    workspace_id: UuidSchema,
  })
  .strict();

export const IngestJobViewSchema = z
  .object({
    attempt_count: z.number().int().nonnegative(),
    created_at: IsoDateTimeSchema,
    error: z
      .object({
        code: z.string().trim().min(1).max(80),
        message: z.string().trim().min(1).max(2_000),
        schema_version: z.literal('job-error@1'),
      })
      .strict()
      .nullable(),
    finished_at: IsoDateTimeSchema.nullable(),
    id: UuidSchema,
    progress: z.number().int().min(0).max(100),
    source_document_id: UuidSchema,
    stage: z.enum(['queued', 'upload', 'scan', 'parse', 'chunk', 'embed', 'index', 'done']),
    started_at: IsoDateTimeSchema.nullable(),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
    tenant_id: UuidSchema,
    updated_at: IsoDateTimeSchema,
  })
  .strict();

export const SourceChunkViewSchema = z
  .object({
    chunk_no: z.number().int().nonnegative(),
    created_at: IsoDateTimeSchema,
    id: UuidSchema,
    metadata: z
      .object({
        char_end: z.number().int().nonnegative(),
        char_start: z.number().int().nonnegative(),
        headings: z.array(z.string()).max(32).optional(),
        page: z.number().int().positive().optional(),
        schema_version: z.literal('chunk-metadata@1'),
        url: z.string().url().max(8_192).optional(),
      })
      .strict(),
    source_document_id: UuidSchema,
    status: z.enum(['active', 'inactive']),
    text: z.string().min(1),
    text_hash: Sha256Schema,
    token_count: z.number().int().min(1).max(900),
  })
  .strict();

export const FactEvidenceViewSchema = z
  .object({
    chunk_id: UuidSchema,
    created_at: IsoDateTimeSchema,
    id: UuidSchema,
    quote_hash: Sha256Schema,
    quote_text: z.string().min(1),
    source_document_id: UuidSchema,
  })
  .strict();

export const FactViewSchema = z
  .object({
    confidence: z.number().min(0).max(1),
    created_at: IsoDateTimeSchema,
    evidence: z.array(FactEvidenceViewSchema).optional(),
    id: UuidSchema,
    object_value: z.string().min(1),
    predicate: z.string().trim().min(1).max(120),
    status: z.enum(['candidate', 'verified', 'conflicted', 'retired']),
    subject: z.string().trim().min(1).max(240),
    tenant_id: UuidSchema,
    unit: z.string().trim().min(1).max(32).nullable(),
    updated_at: IsoDateTimeSchema,
    valid_from: IsoDateSchema.nullable(),
    valid_to: IsoDateSchema.nullable(),
    workspace_id: UuidSchema,
  })
  .strict();

export const FactQuerySchema = SourceScopeQuerySchema.extend({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  predicate: z.string().trim().min(1).max(120).optional(),
  search: z.string().trim().min(1).max(240).optional(),
  source_id: UuidSchema.optional(),
  status: z.enum(['candidate', 'verified', 'conflicted', 'retired']).optional(),
  subject: z.string().trim().min(1).max(240).optional(),
}).strict();

export const VerifyFactRequestSchema = z
  .object({
    decision: z.enum(['verified', 'conflicted', 'retired']),
    expected_updated_at: IsoDateTimeSchema,
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const SourceUploadResponseSchema = z
  .object({
    data: z.object({ source: SourceViewSchema, ingest_job: IngestJobViewSchema }).strict(),
    meta: RequestMetaSchema,
  })
  .strict();

export const SourcePageSchema = z
  .object({ data: z.array(SourceViewSchema), meta: CursorPageMetaSchema })
  .strict();

export const SourceResponseSchema = z
  .object({ data: SourceViewSchema, meta: RequestMetaSchema })
  .strict();

export const IngestJobResponseSchema = z
  .object({ data: IngestJobViewSchema, meta: RequestMetaSchema })
  .strict();

export const FactResponseSchema = z
  .object({ data: FactViewSchema, meta: RequestMetaSchema })
  .strict();

export const FactPageSchema = z
  .object({ data: z.array(FactViewSchema), meta: CursorPageMetaSchema })
  .strict();

export const SourceDetailResponseSchema = z
  .object({
    data: z
      .object({
        chunks: z.array(SourceChunkViewSchema),
        citation_count: z.number().int().nonnegative(),
        facts: z.array(FactViewSchema),
        ingest_jobs: z.array(IngestJobViewSchema),
        source: SourceViewSchema,
      })
      .strict(),
    meta: RequestMetaSchema,
  })
  .strict();

export const NoContentResponseSchema = z.undefined();

export type SourceListQuery = z.infer<typeof SourceListQuerySchema>;
export type SourceScopeQuery = z.infer<typeof SourceScopeQuerySchema>;
export type FactQuery = z.infer<typeof FactQuerySchema>;
export type ReindexRequest = z.infer<typeof ReindexRequestSchema>;
export type VerifyFactRequest = z.infer<typeof VerifyFactRequestSchema>;
export type SourceView = z.infer<typeof SourceViewSchema>;
export type IngestJobView = z.infer<typeof IngestJobViewSchema>;
export type SourceChunkView = z.infer<typeof SourceChunkViewSchema>;
export type FactView = z.infer<typeof FactViewSchema>;
