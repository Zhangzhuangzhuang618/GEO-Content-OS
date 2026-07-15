import { z } from 'zod';

import { CitationSchema } from '../cont-04/content-package-detail.schema';
import { ContentVersionSchema } from '../cont-05/content-editor.schema';
import { ContentVariantSchema } from '../cont-03/content-package-list.schema';

export const QualityIssueSchema = z
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
    citation_ids: z.array(z.string().uuid()),
    location: z.string().nullable(),
    message: z.string().min(1),
    rule_id: z.string().min(1),
    severity: z.enum(['BLOCK', 'WARN', 'INFO']),
    suggestion: z.string().nullable(),
  })
  .strict();

export const GeoScoresSchema = z
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

export const QualityReportSchema = z
  .object({
    checker_version: z.string().min(1),
    content_version_id: z.string().uuid(),
    created_at: z.iso.datetime(),
    decision: z.enum(['pass', 'revise', 'block']),
    generation_run_id: z.string().uuid(),
    geo_scores: GeoScoresSchema,
    id: z.string().uuid(),
    issues: z.array(QualityIssueSchema),
    score: z.number().min(0).max(100),
    tenant_id: z.string().uuid(),
    variant_id: z.string().uuid(),
  })
  .strict();

export const QualityVariantDetailResponseSchema = z
  .object({
    data: z
      .object({
        citations: z.array(CitationSchema),
        current_content: ContentVersionSchema.nullable(),
        locks: z.array(z.unknown()),
        quality_report: QualityReportSchema.nullable(),
        variant: ContentVariantSchema,
        versions: z.array(z.unknown()),
      })
      .strict(),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export const QualityMutationResponseSchema = z
  .object({
    data: z.object({ id: z.string().uuid() }).passthrough(),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export type QualityVariantDetail = z.infer<typeof QualityVariantDetailResponseSchema>['data'];
export type QualityIssue = z.infer<typeof QualityIssueSchema>;
