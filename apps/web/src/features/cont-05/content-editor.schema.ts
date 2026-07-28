import { z } from 'zod';

import { CitationSchema, QualityReportSchema } from '../cont-04/content-package-detail.schema';
import { ContentVariantSchema } from '../cont-03/content-package-list.schema';

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const BlockKeySchema = z.string().regex(/^[a-z0-9_-]{1,80}$/u);

export const ContentBlockSchema = z
  .object({
    block_key: BlockKeySchema,
    block_type: z.enum(['heading', 'paragraph', 'list', 'quote', 'media', 'cta']),
    content_version_id: z.string().uuid(),
    created_at: z.iso.datetime(),
    id: z.string().uuid(),
    position: z.number().int().nonnegative(),
    tenant_id: z.string().uuid(),
    text_hash: HashSchema,
  })
  .strict();

export const EditableBlockSchema = z
  .object({
    block_key: BlockKeySchema,
    block_type: z.enum(['heading', 'paragraph', 'list', 'quote', 'media', 'cta']),
    text: z.string().max(100_000),
  })
  .strict();

export const ContentDocumentSchema = z
  .object({
    blocks: z
      .array(EditableBlockSchema)
      .min(1)
      .max(1000)
      .refine((blocks) => new Set(blocks.map((block) => block.block_key)).size === blocks.length, {
        message: 'block_key 必须唯一',
      }),
    citation_map: z.array(
      z
        .object({
          citation_ids: z.array(z.string().uuid()).max(100),
          claim_key: z.string().min(1).max(160),
          claim_text: z.string().min(1).max(4000),
        })
        .strict(),
    ),
    cta: z.string().max(500).nullable(),
    hashtags: z.array(z.string().min(1).max(80)).max(100),
    platform_code: z.enum([
      'master',
      'official_site',
      'baijiahao',
      'toutiao',
      'zhihu',
      'xiaohongshu',
      'wechat_mp',
      'douyin',
    ]),
    platform_meta: z.record(z.string(), z.unknown()),
    schema_version: z.literal('content-writer-data@1'),
    summary: z.string().max(1000),
    title: z.string().min(2).max(80),
  })
  .strict();

export const ContentVersionSchema = z
  .object({
    blocks: z.array(ContentBlockSchema),
    content_hash: HashSchema,
    content_json: ContentDocumentSchema,
    created_at: z.iso.datetime(),
    created_by: z.string().uuid(),
    id: z.string().uuid(),
    package_id: z.string().uuid(),
    schema_version: z.literal('content-writer-data@1'),
    source_run_id: z.string().uuid().nullable(),
    tenant_id: z.string().uuid(),
    variant_id: z.string().uuid().nullable(),
    version_no: z.number().int().positive(),
  })
  .strict();

export const BlockLockSchema = z
  .object({
    block_key: BlockKeySchema,
    created_at: z.iso.datetime(),
    id: z.string().uuid(),
    locked_by: z.string().uuid(),
    locked_content_hash: HashSchema,
    reason: z.string().nullable(),
    tenant_id: z.string().uuid(),
    updated_at: z.iso.datetime(),
    variant_id: z.string().uuid(),
  })
  .strict();

export const VariantDetailSchema = z
  .object({
    automation_run: z.unknown().nullable().optional(),
    citations: z.array(CitationSchema),
    current_content: ContentVersionSchema.nullable(),
    locks: z.array(BlockLockSchema),
    quality_report: QualityReportSchema.nullable(),
    quality_reports: z.array(QualityReportSchema).default([]),
    variant: ContentVariantSchema,
    versions: z.array(ContentVersionSchema),
  })
  .strict();

export const VariantDetailResponseSchema = z
  .object({
    data: VariantDetailSchema,
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export const ContentDiffSchema = z
  .object({
    base: z.object({
      content_hash: HashSchema,
      id: z.string().uuid(),
      version_no: z.number().int(),
    }),
    blocks: z.array(
      z.object({
        after: z.unknown().optional(),
        before: z.unknown().optional(),
        block_key: z.string(),
        change: z.enum(['added', 'modified', 'moved', 'removed']),
      }),
    ),
    fields: z.array(
      z.object({
        after: z.unknown().optional(),
        before: z.unknown().optional(),
        field: z.string(),
      }),
    ),
    target: z.object({
      content_hash: HashSchema,
      id: z.string().uuid(),
      version_no: z.number().int(),
    }),
  })
  .strict();

export const ContentDiffResponseSchema = z
  .object({
    data: ContentDiffSchema,
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export const GenerationResponseSchema = z
  .object({
    data: z.object({ id: z.string().uuid() }).passthrough(),
    meta: z.object({ request_id: z.string() }).passthrough(),
  })
  .strict();

export type ContentDocument = z.infer<typeof ContentDocumentSchema>;
export type EditableBlock = z.infer<typeof EditableBlockSchema>;
export type VariantDetail = z.infer<typeof VariantDetailSchema>;
export type ContentDiff = z.infer<typeof ContentDiffSchema>;
export type ModelPolicy = 'fast' | 'balanced' | 'quality';
