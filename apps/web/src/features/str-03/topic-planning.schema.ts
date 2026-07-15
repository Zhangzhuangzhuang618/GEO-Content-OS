import { z } from 'zod';

export const PlatformCodeSchema = z.enum([
  'official_website',
  'baijiahao',
  'toutiao',
  'zhihu',
  'xiaohongshu',
  'wechat_official',
  'douyin',
]);
export const TopicStatusSchema = z.enum(['proposed', 'adopted', 'archived']);
export const TopicRiskSchema = z.enum(['low', 'medium', 'high', 'critical']);

export const TopicCandidateSchema = z
  .object({
    brief_suggestion: z.unknown().nullable(),
    created_at: z.iso.datetime(),
    entities: z.array(z.string().min(1)),
    evidence_ids: z.array(z.string().uuid()),
    generation_run_id: z.string().uuid(),
    id: z.string().uuid(),
    intent: z.string().min(1),
    platform_codes: z.array(PlatformCodeSchema).min(1),
    priority: z.number().int().min(0).max(100),
    project_id: z.string().uuid(),
    question: z.string().min(5),
    risk_level: TopicRiskSchema,
    status: TopicStatusSchema,
    tenant_id: z.string().uuid(),
    updated_at: z.iso.datetime(),
    version: z.number().int().positive(),
    workspace_id: z.string().uuid(),
  })
  .strict()
  .refine(
    (value) => value.evidence_ids.length > 0 || ['high', 'critical'].includes(value.risk_level),
    { message: '无证据选题必须为高风险', path: ['risk_level'] },
  );

export const TopicPageSchema = z
  .object({
    data: z.array(TopicCandidateSchema),
    meta: z.object({ next_cursor: z.string().nullable(), request_id: z.string().min(1) }).strict(),
  })
  .strict();

export const GenerationRunResponseSchema = z
  .object({
    data: z.object({ id: z.string().uuid(), status: z.string().min(1) }).passthrough(),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export const BriefResponseSchema = z
  .object({
    data: z.object({ id: z.string().uuid(), title: z.string().min(1) }).passthrough(),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export type PlatformCode = z.infer<typeof PlatformCodeSchema>;
export type TopicCandidate = z.infer<typeof TopicCandidateSchema>;
export type TopicRisk = z.infer<typeof TopicRiskSchema>;
export type TopicStatus = z.infer<typeof TopicStatusSchema>;

export interface TopicFilters {
  platformCode?: PlatformCode;
  riskLevel?: TopicRisk;
  status?: TopicStatus;
}

export interface TopicPlanInput {
  readonly keywordSetIds: readonly string[];
  readonly maxTopics: number;
  readonly platformCodes: readonly PlatformCode[];
  readonly projectId: string;
  readonly seedQueries: readonly string[];
  readonly workspaceId: string;
}
