import { z } from 'zod';

export const SkillNameSchema = z.enum([
  'material-parser',
  'content-writer',
  'fact-checker',
  'topic-planner',
  'geo-optimizer',
  'quality-checker',
]);
export const PlatformCodeSchema = z.enum([
  'official_site',
  'baijiahao',
  'sohu',
  'toutiao',
  'zhihu',
  'xiaohongshu',
  'wechat_mp',
  'douyin',
]);
export const ConfigStatusSchema = z.enum(['draft', 'published', 'retired']);
export const RulesSchema = z
  .object({ schema_version: z.literal('platform-rules@1') })
  .catchall(z.json());

const SharedVersionSchema = z.object({
  change_summary: z.string().min(1).max(500),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/u),
  created_at: z.iso.datetime(),
  created_by: z.string().uuid(),
  created_by_name: z.string().min(1),
  id: z.string().uuid(),
  published_at: z.iso.datetime().nullable(),
  published_by: z.string().uuid().nullable(),
  published_by_name: z.string().min(1).nullable(),
  semantic_version: z.string().min(1),
  status: ConfigStatusSchema,
  version: z.number().int().positive(),
});

export const PromptVersionSchema = SharedVersionSchema.extend({
  schema_version: z.string().min(1),
  skill_name: SkillNameSchema,
  system_prompt: z.string().min(1),
  task_template: z.string().min(1),
}).strict();

export const RuleVersionSchema = SharedVersionSchema.extend({
  platform_code: PlatformCodeSchema,
  rules: RulesSchema,
}).strict();

function pageResponse<T extends z.ZodType>(item: T) {
  return z
    .object({
      data: z.object({ items: z.array(item), next_cursor: z.string().nullable() }).strict(),
      meta: z.object({ request_id: z.string().min(1) }).passthrough(),
    })
    .strict();
}

function dataResponse<T extends z.ZodType>(item: T) {
  return z
    .object({
      data: item,
      meta: z.object({ request_id: z.string().min(1) }).passthrough(),
    })
    .strict();
}

export const PromptPageResponseSchema = pageResponse(PromptVersionSchema);
export const RulePageResponseSchema = pageResponse(RuleVersionSchema);
export const PromptResponseSchema = dataResponse(PromptVersionSchema);
export const RuleResponseSchema = dataResponse(RuleVersionSchema);

export type PromptVersion = z.infer<typeof PromptVersionSchema>;
export type RuleVersion = z.infer<typeof RuleVersionSchema>;
export type SkillName = z.infer<typeof SkillNameSchema>;
export type PlatformCode = z.infer<typeof PlatformCodeSchema>;
export type ConfigStatus = z.infer<typeof ConfigStatusSchema>;
