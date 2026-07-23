import { z } from 'zod';

import {
  ContentPackageSchema,
  ContentVariantSchema,
  type ContentPackage,
  type ContentVariant,
} from '../cont-03/content-package-list.schema';

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const GenerationRunSchema = z
  .object({
    created_at: z.iso.datetime(),
    error: z.record(z.string(), z.unknown()).nullable(),
    finished_at: z.iso.datetime().nullable(),
    id: z.string().uuid(),
    input_hash: HashSchema,
    model_key: z.string().min(1),
    package_id: z.string().uuid().nullable(),
    project_id: z.string().uuid().nullable(),
    prompt_version_id: z.string().uuid(),
    request_id: z.string().min(1),
    skill_name: z.string().min(1),
    skill_version: z.string().min(1),
    started_at: z.iso.datetime().nullable(),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
    tenant_id: z.string().uuid(),
    updated_at: z.iso.datetime(),
    variant_id: z.string().uuid().nullable(),
    version: z.number().int().positive(),
    workspace_id: z.string().uuid(),
  })
  .strict();

export const ContentVersionSchema = z
  .object({
    blocks: z.array(z.unknown()),
    content_hash: HashSchema,
    content_json: z
      .object({
        blocks: z.array(z.unknown()),
        summary: z.string(),
        title: z.string(),
      })
      .passthrough(),
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

export const CitationSchema = z
  .object({
    chunk_id: z.string().uuid(),
    claim_key: z.string(),
    claim_text: z.string(),
    content_version_id: z.string().uuid(),
    created_at: z.iso.datetime(),
    id: z.string().uuid(),
    quote_hash: HashSchema,
    quote_text: z.string(),
    tenant_id: z.string().uuid(),
  })
  .strict();

export const QualityReportSchema = z
  .object({
    content_version_id: z.string().uuid(),
    decision: z.enum(['pass', 'revise', 'block']),
    id: z.string().uuid(),
    score: z.number().min(0).max(100),
    variant_id: z.string().uuid(),
  })
  .passthrough();

export const OfficialSiteAutomationRunSchema = z
  .object({
    content_version_id: z.string().uuid(),
    finished_at: z.iso.datetime().nullable(),
    id: z.string().uuid(),
    last_error: z.record(z.string(), z.unknown()).nullable(),
    publish_job_id: z.string().uuid().nullable(),
    rewrite_count: z.number().int().min(0).max(3),
    status: z.enum([
      'quality_pending',
      'rewrite_pending',
      'rewriting',
      'publish_pending',
      'publishing',
      'published',
      'manual_required',
      'publish_failed',
      'disabled',
    ]),
    updated_at: z.iso.datetime(),
  })
  .strict();

export const ContentPackageBaseDetailResponseSchema = z
  .object({
    data: z
      .object({
        generation_runs: z.array(GenerationRunSchema),
        master_content: ContentVersionSchema.nullable(),
        package: ContentPackageSchema,
        variants: z.array(ContentVariantSchema).min(1).max(7),
      })
      .strict(),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export const ContentVariantDetailResponseSchema = z
  .object({
    data: z
      .object({
        automation_run: OfficialSiteAutomationRunSchema.nullable(),
        citations: z.array(CitationSchema),
        current_content: ContentVersionSchema.nullable(),
        locks: z.array(z.unknown()),
        quality_report: QualityReportSchema.nullable(),
        variant: ContentVariantSchema,
        versions: z.array(ContentVersionSchema),
      })
      .strict(),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export const GenerationRunResponseSchema = z
  .object({
    data: GenerationRunSchema,
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export const MutationSuccessSchema = z
  .object({
    data: z.object({ id: z.string().uuid() }).passthrough(),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export type GenerationRun = z.infer<typeof GenerationRunSchema>;
export type ContentVersion = z.infer<typeof ContentVersionSchema>;
export type Citation = z.infer<typeof CitationSchema>;
export type QualityReport = z.infer<typeof QualityReportSchema>;
export type OfficialSiteAutomationRun = z.infer<typeof OfficialSiteAutomationRunSchema>;

export interface VariantDetail {
  readonly automationRun: OfficialSiteAutomationRun | null;
  readonly citations: readonly Citation[];
  readonly currentContent: ContentVersion | null;
  readonly qualityReport: QualityReport | null;
  readonly variant: ContentVariant;
  readonly versions: readonly ContentVersion[];
}

export interface PackageDetail {
  readonly generationRuns: readonly GenerationRun[];
  readonly masterContent: ContentVersion | null;
  readonly package: ContentPackage;
  readonly variants: readonly VariantDetail[];
}

export type PackageAction = 'generate' | 'quality-check' | 'abandon' | 'archive' | 'submit-review';
export type ModelPolicy = 'fast' | 'balanced' | 'quality';
