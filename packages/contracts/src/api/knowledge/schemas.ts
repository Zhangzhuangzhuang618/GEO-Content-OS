import { z } from 'zod';

import {
  CursorPageMetaSchema,
  CursorSchema,
  IsoDateTimeSchema,
  RequestMetaSchema,
  UuidSchema,
} from '../common.js';

const IsoDateSchema = z.string().date();

function containsSensitiveIdentifier(value: string): boolean {
  return (
    /(^|\D)1[3-9][0-9]{9}(\D|$)/u.test(value) ||
    /(^|[^0-9A-Za-z])[0-9]{17}[0-9Xx]([^0-9A-Za-z]|$)/u.test(value) ||
    /(^|\D)[0-9]{16,19}(\D|$)/u.test(value) ||
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u.test(value)
  );
}
const InsuranceSummaryTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine((value) => !containsSensitiveIdentifier(value), {
    message: 'Insurance proof summary fields must not contain personal identifiers',
  });
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const LanguageSchema = z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u);
const HttpsUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  });

export const CertificateSourceProfileSchema = z
  .object({
    article_use_allowed: z.boolean(),
    certificate_name: z.string().trim().min(1).max(240),
    certificate_number: z.string().trim().min(1).max(120),
    holder_name: z.string().trim().min(1).max(240),
    issuing_authority: z.string().trim().min(1).max(240),
    public_display_confirmed: z.boolean(),
    schema_version: z.literal('source-certificate@1'),
    verification_url: HttpsUrlSchema.nullable(),
  })
  .strict();

export const InsuranceProofSourceProfileSchema = z
  .object({
    insurance_type: InsuranceSummaryTextSchema,
    insured_count: z.number().int().min(1).max(100_000),
    insurer_name: InsuranceSummaryTextSchema,
    policyholder_name: InsuranceSummaryTextSchema,
    schema_version: z.literal('source-insurance-proof@1'),
    summary_use_confirmed: z.literal(true),
  })
  .strict();

export const SourceIdSchema = UuidSchema;
export const IngestJobIdSchema = UuidSchema;
export const FactIdSchema = UuidSchema;

export const SourceCreateSchema = z
  .object({
    article_use_allowed: z.boolean().optional(),
    certificate_name: z.string().trim().min(1).max(240).optional(),
    certificate_number: z.string().trim().min(1).max(120).optional(),
    effective_from: IsoDateSchema.nullable().optional(),
    effective_to: IsoDateSchema.nullable().optional(),
    file: z.unknown().optional(),
    holder_name: z.string().trim().min(1).max(240).optional(),
    insurance_type: InsuranceSummaryTextSchema.optional(),
    insured_count: z.coerce.number().int().min(1).max(100_000).optional(),
    insurer_name: InsuranceSummaryTextSchema.optional(),
    issuing_authority: z.string().trim().min(1).max(240).optional(),
    language: LanguageSchema.default('zh-CN'),
    material_kind: z.enum(['document', 'certificate', 'insurance_proof']).default('document'),
    policyholder_name: InsuranceSummaryTextSchema.optional(),
    project_id: UuidSchema.nullable().optional(),
    public_display_confirmed: z.boolean().optional(),
    summary_use_confirmed: z.boolean().optional(),
    title: z.string().trim().min(1).max(240),
    trust_level: z.enum(['verified', 'normal', 'untrusted']).default('normal'),
    url: z.string().url().max(2_048).optional(),
    verification_url: HttpsUrlSchema.optional(),
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
    const certificateFields = [
      value.certificate_name,
      value.certificate_number,
      value.holder_name,
      value.issuing_authority,
    ];
    const insuranceFields = [
      value.insurance_type,
      value.insured_count,
      value.insurer_name,
      value.policyholder_name,
    ];
    if (value.material_kind === 'certificate' && certificateFields.some((field) => !field)) {
      context.addIssue({
        code: 'custom',
        message: 'Certificate fields are required for certificate material',
        path: ['certificate_name'],
      });
    }
    if (value.material_kind === 'certificate' && value.file === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Certificate material requires an image file',
        path: ['file'],
      });
    }
    if (value.material_kind === 'insurance_proof') {
      if (insuranceFields.some((field) => field === undefined)) {
        context.addIssue({
          code: 'custom',
          message: 'Insurance proof fields are required',
          path: ['insurer_name'],
        });
      }
      if (value.file === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Insurance proof requires a PDF file',
          path: ['file'],
        });
      }
      if (!value.effective_from || !value.effective_to) {
        context.addIssue({
          code: 'custom',
          message: 'Insurance proof requires a complete coverage period',
          path: ['effective_from'],
        });
      }
      if (value.trust_level !== 'verified') {
        context.addIssue({
          code: 'custom',
          message: 'Insurance proof must be verified before its summary is indexed',
          path: ['trust_level'],
        });
      }
      if (value.summary_use_confirmed !== true) {
        context.addIssue({
          code: 'custom',
          message: 'Insurance proof summary use must be confirmed',
          path: ['summary_use_confirmed'],
        });
      }
    }
    if (
      value.material_kind !== 'certificate' &&
      (certificateFields.some(Boolean) ||
        value.verification_url !== undefined ||
        value.article_use_allowed !== undefined ||
        value.public_display_confirmed !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Certificate fields are only allowed for certificate material',
        path: ['material_kind'],
      });
    }
    if (
      value.material_kind !== 'insurance_proof' &&
      (insuranceFields.some((field) => field !== undefined) ||
        value.summary_use_confirmed !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Insurance proof fields are only allowed for insurance proof material',
        path: ['material_kind'],
      });
    }
    if (value.article_use_allowed && !value.public_display_confirmed) {
      context.addIssue({
        code: 'custom',
        message: 'Public display confirmation is required before article use',
        path: ['public_display_confirmed'],
      });
    }
  });

export const BatchUrlPreviewRequestSchema = z
  .object({
    file: z.unknown(),
    sheet_name: z.string().trim().min(1).max(120).optional(),
    start_row: z.coerce.number().int().min(1).max(100_000).optional(),
    title_column: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{1,2}$/u)
      .optional(),
    url_column: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{1,2}$/u)
      .default('D'),
  })
  .strict();

export const BatchUrlPreviewRowSchema = z
  .object({
    message: z.string().min(1).max(240).nullable(),
    row_number: z.number().int().positive(),
    status: z.enum(['ready', 'invalid', 'duplicate']),
    title: z.string().min(1).max(240).nullable(),
    url: z.string().min(1).max(2_048),
  })
  .strict();

export const BatchUrlPreviewResponseSchema = z
  .object({
    data: z
      .object({
        duplicate_rows: z.number().int().nonnegative(),
        file_name: z.string().min(1).max(255),
        invalid_rows: z.number().int().nonnegative(),
        ready_rows: z.number().int().nonnegative(),
        rows: z.array(BatchUrlPreviewRowSchema).max(500),
        sheet_name: z.string().min(1).max(120),
        sheets: z.array(z.string().min(1).max(120)).min(1),
        start_row: z.number().int().positive().max(100_000),
        title_column: z
          .string()
          .regex(/^[A-Z]{1,2}$/u)
          .nullable(),
        total_rows: z.number().int().nonnegative().max(500),
        url_column: z.string().regex(/^[A-Z]{1,2}$/u),
      })
      .strict(),
    meta: RequestMetaSchema,
  })
  .strict();

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

export const SourceListItemSchema = SourceViewSchema.extend({
  parsed_at: IsoDateTimeSchema.nullable(),
}).strict();

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
  .object({ data: z.array(SourceListItemSchema), meta: CursorPageMetaSchema })
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
        certificate: CertificateSourceProfileSchema.nullable(),
        insurance_proof: InsuranceProofSourceProfileSchema.nullable(),
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
export type BatchUrlPreview = z.infer<typeof BatchUrlPreviewResponseSchema>['data'];
export type SourceScopeQuery = z.infer<typeof SourceScopeQuerySchema>;
export type FactQuery = z.infer<typeof FactQuerySchema>;
export type ReindexRequest = z.infer<typeof ReindexRequestSchema>;
export type VerifyFactRequest = z.infer<typeof VerifyFactRequestSchema>;
export type SourceView = z.infer<typeof SourceViewSchema>;
export type CertificateSourceProfile = z.infer<typeof CertificateSourceProfileSchema>;
export type InsuranceProofSourceProfile = z.infer<typeof InsuranceProofSourceProfileSchema>;
export type SourceListItem = z.infer<typeof SourceListItemSchema>;
export type IngestJobView = z.infer<typeof IngestJobViewSchema>;
export type SourceChunkView = z.infer<typeof SourceChunkViewSchema>;
export type FactView = z.infer<typeof FactViewSchema>;
