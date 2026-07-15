import { z } from 'zod';

import {
  BriefObjectiveSchema,
  BriefSchema,
  PlatformCodeSchema,
} from '../cont-01/brief-list.schema';

const UniqueUuidListSchema = z
  .array(z.string().uuid())
  .max(100)
  .refine((values) => new Set(values).size === values.length, { message: 'UUID 必须唯一' });

export const BriefSaveInputSchema = z
  .object({
    audience: z.string().trim().min(10).max(500),
    constraints: z
      .object({
        additional_instructions: z.string().trim().min(1).max(5_000).nullable(),
        cta: z.string().trim().min(1).max(500).nullable(),
        schema_version: z.literal('brief-constraints@1'),
      })
      .strict(),
    due_at: z.iso.datetime().nullable(),
    keyword_ids: UniqueUuidListSchema.min(1),
    objective: BriefObjectiveSchema,
    platform_codes: z.array(PlatformCodeSchema).min(1),
    primary_keyword_id: z.string().uuid(),
    project_id: z.string().uuid(),
    source_ids: UniqueUuidListSchema,
    title: z.string().trim().min(2).max(80),
    workspace_id: z.string().uuid(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.keyword_ids.includes(value.primary_keyword_id)) {
      context.addIssue({ code: 'custom', message: '主关键词必须包含在关键词列表中' });
    }
    if (['trust', 'education'].includes(value.objective) && value.source_ids.length === 0) {
      context.addIssue({ code: 'custom', message: '事实型 Brief 至少需要一个证据来源' });
    }
  });

export const BriefResponseSchema = z
  .object({
    data: BriefSchema,
    meta: z.object({ request_id: z.string().min(1) }).strict(),
  })
  .strict();

export const ContentPackageResponseSchema = z
  .object({
    data: z.object({ id: z.string().uuid(), status: z.string().min(1) }).passthrough(),
    meta: z.object({ request_id: z.string().min(1) }).passthrough(),
  })
  .strict();

export type BriefSaveInput = z.infer<typeof BriefSaveInputSchema>;
