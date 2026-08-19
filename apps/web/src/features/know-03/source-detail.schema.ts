import { z } from 'zod';

const UuidSchema = z.string().uuid();
const DateTimeSchema = z.iso.datetime();
const HashSchema = z.string().regex(/^[0-9a-f]{64}$/u);

const CertificateSchema = z
  .object({
    article_use_allowed: z.boolean(),
    certificate_name: z.string().min(1),
    certificate_number: z.string().min(1),
    holder_name: z.string().min(1),
    issuing_authority: z.string().min(1),
    public_display_confirmed: z.boolean(),
    schema_version: z.literal('source-certificate@1'),
    verification_url: z.string().url().nullable(),
  })
  .strict();

const InsuranceProofSchema = z
  .object({
    insurance_type: z.string().min(1),
    insured_count: z.number().int().min(1).max(100_000),
    insurer_name: z.string().min(1),
    policyholder_name: z.string().min(1),
    schema_version: z.literal('source-insurance-proof@1'),
    summary_use_confirmed: z.literal(true),
  })
  .strict();

export const SourceSchema = z
  .object({
    content_hash: HashSchema,
    created_at: DateTimeSchema,
    created_by: UuidSchema,
    effective_from: z.iso.date().nullable(),
    effective_to: z.iso.date().nullable(),
    id: UuidSchema,
    language: z.string().min(1),
    mime_type: z.string().min(1),
    project_id: UuidSchema.nullable(),
    source_type: z.enum(['pdf', 'docx', 'txt', 'url', 'image']),
    status: z.enum(['processing', 'active', 'expired', 'failed']),
    tenant_id: UuidSchema,
    title: z.string().min(1),
    trust_level: z.enum(['verified', 'normal', 'untrusted']),
    updated_at: DateTimeSchema,
    workspace_id: UuidSchema,
  })
  .strict();

export const IngestJobSchema = z
  .object({
    attempt_count: z.number().int().nonnegative(),
    created_at: DateTimeSchema,
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        schema_version: z.literal('job-error@1'),
      })
      .strict()
      .nullable(),
    finished_at: DateTimeSchema.nullable(),
    id: UuidSchema,
    progress: z.number().int().min(0).max(100),
    source_document_id: UuidSchema,
    stage: z.enum(['queued', 'upload', 'scan', 'parse', 'chunk', 'embed', 'index', 'done']),
    started_at: DateTimeSchema.nullable(),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
    tenant_id: UuidSchema,
    updated_at: DateTimeSchema,
  })
  .strict();

export const ChunkSchema = z
  .object({
    chunk_no: z.number().int().nonnegative(),
    created_at: DateTimeSchema,
    id: UuidSchema,
    metadata: z
      .object({
        char_end: z.number().int().nonnegative(),
        char_start: z.number().int().nonnegative(),
        headings: z.array(z.string()).optional(),
        page: z.number().int().positive().optional(),
        schema_version: z.literal('chunk-metadata@1'),
        url: z.string().url().optional(),
      })
      .strict(),
    source_document_id: UuidSchema,
    status: z.enum(['active', 'inactive']),
    text: z.string().min(1),
    text_hash: HashSchema,
    token_count: z.number().int().positive(),
  })
  .strict();

const EvidenceSchema = z
  .object({
    chunk_id: UuidSchema,
    created_at: DateTimeSchema,
    id: UuidSchema,
    quote_hash: HashSchema,
    quote_text: z.string().min(1),
    source_document_id: UuidSchema,
  })
  .strict();

export const FactSchema = z
  .object({
    confidence: z.number().min(0).max(1),
    created_at: DateTimeSchema,
    evidence: z.array(EvidenceSchema).optional(),
    id: UuidSchema,
    object_value: z.string().min(1),
    predicate: z.string().min(1),
    status: z.enum(['candidate', 'verified', 'conflicted', 'retired']),
    subject: z.string().min(1),
    tenant_id: UuidSchema,
    unit: z.string().min(1).nullable(),
    updated_at: DateTimeSchema,
    valid_from: z.iso.date().nullable(),
    valid_to: z.iso.date().nullable(),
    workspace_id: UuidSchema,
  })
  .strict();

export const SourceDetailResponseSchema = z
  .object({
    data: z
      .object({
        certificate: CertificateSchema.nullable().default(null),
        chunks: z.array(ChunkSchema),
        citation_count: z.number().int().nonnegative(),
        facts: z.array(FactSchema),
        ingest_jobs: z.array(IngestJobSchema),
        insurance_proof: InsuranceProofSchema.nullable().default(null),
        source: SourceSchema,
      })
      .strict(),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export const IngestJobResponseSchema = z
  .object({
    data: IngestJobSchema,
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export type Source = z.infer<typeof SourceSchema>;
export type IngestJob = z.infer<typeof IngestJobSchema>;
export type Chunk = z.infer<typeof ChunkSchema>;
export type Fact = z.infer<typeof FactSchema>;
export type SourceDetailView = z.infer<typeof SourceDetailResponseSchema>['data'];

export interface SourceDetailScope {
  readonly id: string;
  readonly projectId: string;
  readonly workspaceId: string;
}
