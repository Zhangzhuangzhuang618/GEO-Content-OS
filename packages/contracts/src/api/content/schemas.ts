import { z } from 'zod';

import { CONTENT_PACKAGE_STATUSES, CONTENT_VARIANT_STATUSES } from '../../statuses.js';
import { PLATFORM_CODES } from '../../platforms.js';
import {
  BriefListQuerySchema,
  BriefPageSchema,
  BriefResponseSchema,
  CreateBriefRequestSchema,
  GenerationRunResponseSchema,
  GenerationRunViewSchema,
  UpdateBriefRequestSchema,
} from '../topics.js';
import {
  CursorPageMetaSchema,
  CursorSchema,
  IsoDateTimeSchema,
  UuidSchema,
  VersionSchema,
  createDataResponseSchema,
} from '../common.js';

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const UniqueUuidListSchema = z
  .array(UuidSchema)
  .min(1)
  .max(100)
  .refine((values) => new Set(values).size === values.length, {
    message: 'UUID values must be unique',
  });
const UniqueBlockKeyListSchema = z
  .array(z.string().regex(/^[a-z0-9_-]{1,80}$/u))
  .max(500)
  .refine((values) => new Set(values).size === values.length, {
    message: 'Block keys must be unique',
  });

export const ContentIdSchema = UuidSchema;
export const ContentPackageParamsSchema = z.object({ id: UuidSchema }).strict();
export const GenerationRunParamsSchema = z.object({ id: UuidSchema }).strict();
export const ContentVersionParamsSchema = z.object({ id: UuidSchema }).strict();
export const ContentVariantParamsSchema = z.object({ id: UuidSchema }).strict();
export const ContentBlockParamsSchema = z.object({ blockId: UuidSchema, id: UuidSchema }).strict();

export const ContentDocumentSchema = z
  .object({
    blocks: z
      .array(
        z
          .object({
            block_key: z.string().regex(/^[a-z0-9_-]{1,80}$/u),
            block_type: z.enum(['heading', 'paragraph', 'list', 'quote', 'media', 'cta']),
            text: z.string().max(100_000),
          })
          .strict(),
      )
      .min(1)
      .max(1_000)
      .refine((blocks) => new Set(blocks.map((block) => block.block_key)).size === blocks.length, {
        message: 'Block keys must be unique',
      }),
    citation_map: z.array(
      z
        .object({
          citation_ids: z.array(UuidSchema).max(100),
          claim_key: z.string().min(1).max(160),
          claim_text: z.string().min(1).max(4_000),
        })
        .strict(),
    ),
    cta: z.string().max(500).nullable(),
    hashtags: z.array(z.string().min(1).max(80)).max(100),
    platform_code: z.enum(['master', ...PLATFORM_CODES]),
    platform_meta: z.record(z.string(), z.unknown()),
    schema_version: z.literal('content-writer-data@1'),
    summary: z.string().max(1_000),
    title: z.string().min(2).max(80),
  })
  .strict();

export const CreateContentPackageRequestSchema = z
  .object({ brief_id: UuidSchema, project_id: UuidSchema, workspace_id: UuidSchema })
  .strict();

export const ContentPackageQuerySchema = z
  .object({
    created_by: UuidSchema.optional(),
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    platform_code: z.enum(PLATFORM_CODES).optional(),
    project_id: UuidSchema.optional(),
    status: z.enum(CONTENT_PACKAGE_STATUSES).optional(),
    workspace_id: UuidSchema.optional(),
  })
  .strict();

export const GenerateContentRequestSchema = z
  .object({
    locked_block_keys: UniqueBlockKeyListSchema.default([]),
    model_policy: z.enum(['fast', 'balanced', 'quality']).default('balanced'),
    platform_codes: z
      .array(z.enum(PLATFORM_CODES))
      .min(1)
      .max(PLATFORM_CODES.length)
      .refine((values) => new Set(values).size === values.length, {
        message: 'Platform codes must be unique',
      }),
  })
  .strict();

export const ReopenVariantsRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(1_000), variant_ids: UniqueUuidListSchema })
  .strict();

export const CompareVersionQuerySchema = z.object({ target_version_id: UuidSchema }).strict();

export const RollbackRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(1_000).nullable().default(null) })
  .strict();

export const UpdateVariantRequestSchema = z.object({ content: ContentDocumentSchema }).strict();

export const LockBlockRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(1_000).nullable().default(null) })
  .strict();

export const QualityCheckRequestSchema = z
  .object({ mode: z.literal('full').default('full') })
  .strict();

export const RegenerateVariantRequestSchema = z
  .object({
    locked_block_keys: UniqueBlockKeyListSchema.default([]),
    model_policy: z.enum(['fast', 'balanced', 'quality']).default('balanced'),
    quality_report_id: UuidSchema.optional(),
  })
  .strict();

export const DropVariantRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(1_000) })
  .strict();

export const ContentPackageViewSchema = z
  .object({
    brief_id: UuidSchema,
    created_at: IsoDateTimeSchema,
    created_by: UuidSchema,
    id: UuidSchema,
    master_content_version_id: UuidSchema.nullable(),
    project_id: UuidSchema,
    status: z.enum(CONTENT_PACKAGE_STATUSES),
    tenant_id: UuidSchema,
    updated_at: IsoDateTimeSchema,
    version: VersionSchema,
    workspace_id: UuidSchema,
  })
  .strict();

export const ContentVariantViewSchema = z
  .object({
    created_at: IsoDateTimeSchema,
    current_content_version_id: UuidSchema.nullable(),
    id: UuidSchema,
    is_required: z.boolean(),
    package_id: UuidSchema,
    platform_code: z.enum(PLATFORM_CODES),
    quality_score: z.number().min(0).max(100).nullable(),
    status: z.enum(CONTENT_VARIANT_STATUSES),
    tenant_id: UuidSchema,
    updated_at: IsoDateTimeSchema,
    version: VersionSchema,
  })
  .strict();

export const ContentPackageListItemSchema = ContentPackageViewSchema.extend({
  brief_title: z.string().trim().min(1).max(240),
  variants: z.array(ContentVariantViewSchema).max(7),
}).strict();

export const ContentBlockViewSchema = z
  .object({
    block_key: z.string().regex(/^[a-z0-9_-]{1,80}$/u),
    block_type: z.enum(['heading', 'paragraph', 'list', 'quote', 'media', 'cta']),
    content_version_id: UuidSchema,
    created_at: IsoDateTimeSchema,
    id: UuidSchema,
    position: z.number().int().nonnegative(),
    tenant_id: UuidSchema,
    text_hash: HashSchema,
  })
  .strict();

export const ContentVersionViewSchema = z
  .object({
    blocks: z.array(ContentBlockViewSchema),
    content_hash: HashSchema,
    content_json: ContentDocumentSchema,
    created_at: IsoDateTimeSchema,
    created_by: UuidSchema,
    id: UuidSchema,
    package_id: UuidSchema,
    schema_version: z.literal('content-writer-data@1'),
    source_run_id: UuidSchema.nullable(),
    tenant_id: UuidSchema,
    variant_id: UuidSchema.nullable(),
    version_no: z.number().int().positive(),
  })
  .strict();

export const BlockLockViewSchema = z
  .object({
    block_key: z.string().regex(/^[a-z0-9_-]{1,80}$/u),
    created_at: IsoDateTimeSchema,
    id: UuidSchema,
    locked_by: UuidSchema,
    locked_content_hash: HashSchema,
    reason: z.string().nullable(),
    tenant_id: UuidSchema,
    updated_at: IsoDateTimeSchema,
    variant_id: UuidSchema,
    variant_version: VersionSchema,
  })
  .strict();

export const AiCitationViewSchema = z
  .object({
    chunk_id: UuidSchema,
    claim_key: z.string(),
    claim_text: z.string(),
    content_version_id: UuidSchema,
    created_at: IsoDateTimeSchema,
    id: UuidSchema,
    quote_hash: HashSchema,
    quote_text: z.string(),
    tenant_id: UuidSchema,
  })
  .strict();

const QualityIssueSchema = z
  .object({
    category: z.enum([
      'fact',
      'brand',
      'compliance',
      'format',
      'duplicate',
      'readability',
      'security',
    ]),
    citation_ids: z.array(UuidSchema),
    location: z.string().nullable(),
    message: z.string().min(1),
    rule_id: z.string().min(1),
    severity: z.enum(['BLOCK', 'WARN', 'INFO']),
    suggestion: z.string().nullable(),
  })
  .strict();

const GeoScoresSchema = z
  .object({
    answerability: z.number().min(0).max(100),
    entity: z.number().min(0).max(100),
    evidence: z.number().min(0).max(100),
    platform_fit: z.number().min(0).max(100),
    question: z.number().min(0).max(100),
    readability_safety: z.number().min(0).max(100),
    total: z.number().min(0).max(100),
  })
  .strict();

export const QualityReportViewSchema = z
  .object({
    automation_gate: z.record(z.string(), z.unknown()).nullable(),
    checker_version: z.string().min(1).max(32),
    content_version_id: UuidSchema,
    created_at: IsoDateTimeSchema,
    decision: z.enum(['pass', 'revise', 'block']),
    generation_run_id: UuidSchema,
    geo_scores: GeoScoresSchema,
    id: UuidSchema,
    issues: z.array(QualityIssueSchema),
    score: z.number().min(0).max(100),
    tenant_id: UuidSchema,
    variant_id: UuidSchema,
  })
  .strict();

export const ContentPackageDetailSchema = z
  .object({
    generation_runs: z.array(GenerationRunViewSchema),
    master_content: ContentVersionViewSchema.nullable(),
    package: ContentPackageViewSchema,
    variants: z.array(ContentVariantViewSchema).min(1).max(PLATFORM_CODES.length),
  })
  .strict();

export const ContentVariantDetailSchema = z
  .object({
    citations: z.array(AiCitationViewSchema),
    current_content: ContentVersionViewSchema.nullable(),
    locks: z.array(BlockLockViewSchema.omit({ variant_version: true })),
    quality_report: QualityReportViewSchema.nullable(),
    quality_reports: z.array(QualityReportViewSchema),
    variant: ContentVariantViewSchema,
    versions: z.array(ContentVersionViewSchema),
  })
  .strict();

const ContentBlockSnapshotSchema = z
  .object({
    block_key: z.string(),
    block_type: z.string(),
    position: z.number().int().nonnegative(),
    text: z.string(),
    text_hash: HashSchema,
  })
  .strict();

export const ContentDiffViewSchema = z
  .object({
    base: z
      .object({ content_hash: HashSchema, id: UuidSchema, version_no: z.number().int() })
      .strict(),
    blocks: z.array(
      z
        .object({
          after: ContentBlockSnapshotSchema.optional(),
          before: ContentBlockSnapshotSchema.optional(),
          block_key: z.string(),
          change: z.enum(['added', 'modified', 'moved', 'removed']),
        })
        .strict(),
    ),
    fields: z.array(
      z
        .object({
          after: z.unknown().optional(),
          before: z.unknown().optional(),
          field: z.string(),
        })
        .strict(),
    ),
    target: z
      .object({ content_hash: HashSchema, id: UuidSchema, version_no: z.number().int() })
      .strict(),
  })
  .strict();

export const ContentPackageResponseSchema = createDataResponseSchema(ContentPackageViewSchema);
export const ContentPackageDetailResponseSchema = createDataResponseSchema(
  ContentPackageDetailSchema,
);
export const ContentPackagePageSchema = z
  .object({ data: z.array(ContentPackageListItemSchema), meta: CursorPageMetaSchema })
  .strict();
export const ContentVersionResponseSchema = createDataResponseSchema(ContentVersionViewSchema);
export const ContentDiffResponseSchema = createDataResponseSchema(ContentDiffViewSchema);
export const ContentVariantDetailResponseSchema = createDataResponseSchema(
  ContentVariantDetailSchema,
);
export const BlockLockResponseSchema = createDataResponseSchema(BlockLockViewSchema);
export const ContentNoContentResponseSchema = z.null();

export {
  BriefListQuerySchema,
  BriefPageSchema,
  BriefResponseSchema,
  CreateBriefRequestSchema,
  GenerationRunResponseSchema,
  UpdateBriefRequestSchema,
};

export type CreateContentPackageRequest = z.infer<typeof CreateContentPackageRequestSchema>;
export type ContentPackageListItem = z.infer<typeof ContentPackageListItemSchema>;
export type ContentPackageQuery = z.infer<typeof ContentPackageQuerySchema>;
export type GenerateContentRequest = z.infer<typeof GenerateContentRequestSchema>;
export type ReopenVariantsRequest = z.infer<typeof ReopenVariantsRequestSchema>;
export type CompareVersionQuery = z.infer<typeof CompareVersionQuerySchema>;
export type RollbackRequest = z.infer<typeof RollbackRequestSchema>;
export type UpdateVariantRequest = z.infer<typeof UpdateVariantRequestSchema>;
export type LockBlockRequest = z.infer<typeof LockBlockRequestSchema>;
export type QualityCheckRequest = z.infer<typeof QualityCheckRequestSchema>;
export type RegenerateVariantRequest = z.infer<typeof RegenerateVariantRequestSchema>;
export type DropVariantRequest = z.infer<typeof DropVariantRequestSchema>;
export type ContentDocument = z.infer<typeof ContentDocumentSchema>;
