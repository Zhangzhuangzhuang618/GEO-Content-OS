import { z } from 'zod';

export const PlatformCodeSchema = z.enum([
  'official_site',
  'baijiahao',
  'toutiao',
  'zhihu',
  'xiaohongshu',
  'wechat_mp',
  'douyin',
]);
export const BriefObjectiveSchema = z.enum(['awareness', 'conversion', 'trust', 'education']);

export const BriefSchema = z
  .object({
    audience: z.string().min(10),
    constraints: z
      .object({
        additional_instructions: z.string().nullable(),
        cta: z.string().nullable(),
        schema_version: z.literal('brief-constraints@1'),
      })
      .strict(),
    created_at: z.iso.datetime(),
    created_by: z.string().uuid(),
    due_at: z.iso.datetime().nullable(),
    id: z.string().uuid(),
    keyword_ids: z.array(z.string().uuid()).min(1),
    objective: BriefObjectiveSchema,
    platform_codes: z.array(PlatformCodeSchema).min(1),
    primary_keyword_id: z.string().uuid(),
    project_id: z.string().uuid(),
    source_ids: z.array(z.string().uuid()),
    source_topic_candidate_id: z.string().uuid().nullable(),
    tenant_id: z.string().uuid(),
    title: z.string().min(2),
    updated_at: z.iso.datetime(),
    version: z.number().int().positive(),
    workspace_id: z.string().uuid(),
  })
  .strict();

export const BriefPageSchema = z
  .object({
    data: z.array(BriefSchema),
    meta: z.object({ next_cursor: z.string().nullable(), request_id: z.string().min(1) }).strict(),
  })
  .strict();

export type Brief = z.infer<typeof BriefSchema>;
export type BriefObjective = z.infer<typeof BriefObjectiveSchema>;
export type PlatformCode = z.infer<typeof PlatformCodeSchema>;

export interface BriefFilters {
  readonly createdBy?: string;
  readonly cursor?: string;
  readonly objective?: BriefObjective;
  readonly platformCode?: PlatformCode;
  readonly projectId?: string;
  readonly search?: string;
}
