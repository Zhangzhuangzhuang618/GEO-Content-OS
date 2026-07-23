import { z } from 'zod';

import { PLATFORM_CODES } from '../../platforms.js';
import {
  CursorSchema,
  IsoDateTimeSchema,
  ReasonRequestSchema,
  UuidSchema,
  VersionSchema,
  createDataResponseSchema,
} from '../common.js';

export const PLATFORM_CONFIG_SKILL_NAMES = Object.freeze([
  'material-parser',
  'content-writer',
  'fact-checker',
  'topic-planner',
  'geo-optimizer',
  'quality-checker',
] as const);

export const PlatformConfigStatusSchema = z.enum(['draft', 'published', 'retired']);
export const SemanticVersionSchema = z
  .string()
  .min(5)
  .max(32)
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u);
export const ChangeSummarySchema = z.string().trim().min(1).max(500);
export const PlatformRulesSchema = z
  .object({ schema_version: z.literal('platform-rules@1') })
  .catchall(z.json());

export const PromptVersionQuerySchema = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    skill_name: z.enum(PLATFORM_CONFIG_SKILL_NAMES).optional(),
    status: PlatformConfigStatusSchema.optional(),
  })
  .strict();

export const RuleVersionQuerySchema = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    platform_code: z.enum(PLATFORM_CODES).optional(),
    status: PlatformConfigStatusSchema.optional(),
  })
  .strict();

export const CreatePromptVersionRequestSchema = z
  .object({
    change_summary: ChangeSummarySchema,
    schema_version: z.string().trim().min(1).max(32),
    semantic_version: SemanticVersionSchema,
    skill_name: z.enum(PLATFORM_CONFIG_SKILL_NAMES),
    system_prompt: z.string().trim().min(1).max(100_000),
    task_template: z.string().trim().min(1).max(100_000),
  })
  .strict();

export const CreateRuleVersionRequestSchema = z
  .object({
    change_summary: ChangeSummarySchema,
    platform_code: z.enum(PLATFORM_CODES),
    rules: PlatformRulesSchema,
    semantic_version: SemanticVersionSchema,
  })
  .strict();

export const PublishPlatformVersionRequestSchema = z.object({ version: VersionSchema }).strict();

export const PromptVersionViewSchema = z
  .object({
    change_summary: ChangeSummarySchema,
    content_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    created_at: IsoDateTimeSchema,
    created_by: UuidSchema,
    created_by_name: z.string().min(1).max(80),
    id: UuidSchema,
    published_at: IsoDateTimeSchema.nullable(),
    published_by: UuidSchema.nullable(),
    published_by_name: z.string().min(1).max(80).nullable(),
    schema_version: z.string().min(1).max(32),
    semantic_version: SemanticVersionSchema,
    skill_name: z.enum(PLATFORM_CONFIG_SKILL_NAMES),
    status: PlatformConfigStatusSchema,
    system_prompt: z.string().min(1),
    task_template: z.string().min(1),
    version: VersionSchema,
  })
  .strict();

export const RuleVersionViewSchema = z
  .object({
    change_summary: ChangeSummarySchema,
    content_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    created_at: IsoDateTimeSchema,
    created_by: UuidSchema,
    created_by_name: z.string().min(1).max(80),
    id: UuidSchema,
    platform_code: z.enum(PLATFORM_CODES),
    published_at: IsoDateTimeSchema.nullable(),
    published_by: UuidSchema.nullable(),
    published_by_name: z.string().min(1).max(80).nullable(),
    rules: PlatformRulesSchema,
    semantic_version: SemanticVersionSchema,
    status: PlatformConfigStatusSchema,
    version: VersionSchema,
  })
  .strict();

export const PromptVersionPageSchema = z
  .object({ items: z.array(PromptVersionViewSchema), next_cursor: CursorSchema.nullable() })
  .strict();
export const RuleVersionPageSchema = z
  .object({ items: z.array(RuleVersionViewSchema), next_cursor: CursorSchema.nullable() })
  .strict();

export const PromptVersionResponseSchema = createDataResponseSchema(PromptVersionViewSchema);
export const RuleVersionResponseSchema = createDataResponseSchema(RuleVersionViewSchema);
export const PromptVersionPageResponseSchema = createDataResponseSchema(PromptVersionPageSchema);
export const RuleVersionPageResponseSchema = createDataResponseSchema(RuleVersionPageSchema);

export const PlatformConfigIdSchema = UuidSchema;
export { ReasonRequestSchema as RetirePlatformVersionRequestSchema };

export type PromptVersionQuery = z.infer<typeof PromptVersionQuerySchema>;
export type RuleVersionQuery = z.infer<typeof RuleVersionQuerySchema>;
export type CreatePromptVersionRequest = z.infer<typeof CreatePromptVersionRequestSchema>;
export type CreateRuleVersionRequest = z.infer<typeof CreateRuleVersionRequestSchema>;
export type PromptVersionView = z.infer<typeof PromptVersionViewSchema>;
export type RuleVersionView = z.infer<typeof RuleVersionViewSchema>;
export type PlatformConfigStatus = z.infer<typeof PlatformConfigStatusSchema>;
