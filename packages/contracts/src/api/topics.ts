import { z } from 'zod';

import { PLATFORM_CODES } from '../platforms.js';
import { CursorSchema, IsoDateTimeSchema, UuidSchema } from './common.js';

const UniqueUuidListSchema = (maximumItems: number) =>
  z
    .array(UuidSchema)
    .max(maximumItems)
    .refine((values) => new Set(values).size === values.length, {
      message: 'UUID values must be unique',
    });

const PlatformCodeListSchema = z
  .array(z.enum(PLATFORM_CODES))
  .min(1)
  .max(PLATFORM_CODES.length)
  .refine((values) => new Set(values).size === values.length, {
    message: 'Platform codes must be unique',
  });

const UniqueTextListSchema = (minimumItems: number, maximumItems: number) =>
  z
    .array(z.string().trim().min(1).max(240))
    .min(minimumItems)
    .max(maximumItems)
    .refine(
      (values) => new Set(values.map((value) => value.toLowerCase())).size === values.length,
      { message: 'Text values must be unique' },
    );

export const BriefConstraintsSchema = z
  .object({
    additional_instructions: z.string().trim().min(1).max(5_000).nullable().default(null),
    cta: z.string().trim().min(1).max(500).nullable().default(null),
    schema_version: z.literal('brief-constraints@1').default('brief-constraints@1'),
  })
  .strict();

const BriefFieldsSchema = z.object({
  audience: z.string().trim().min(10).max(500),
  constraints: BriefConstraintsSchema.default({
    additional_instructions: null,
    cta: null,
    schema_version: 'brief-constraints@1',
  }),
  due_at: IsoDateTimeSchema.nullable().default(null),
  keyword_ids: UniqueUuidListSchema(100).min(1),
  objective: z.enum(['awareness', 'conversion', 'trust', 'education']),
  primary_keyword_id: UuidSchema,
  title: z.string().trim().min(2).max(80),
});

export const TopicBriefSuggestionSchema =
  BriefFieldsSchema.strict().superRefine(validatePrimaryKeyword);

export const TopicCandidateOutputSchema = z
  .object({
    brief_suggestion: TopicBriefSuggestionSchema,
    entities: UniqueTextListSchema(1, 50),
    evidence_ids: UniqueUuidListSchema(100),
    intent: z.string().trim().min(1).max(32),
    platform_codes: PlatformCodeListSchema,
    priority: z.number().int().min(0).max(100),
    question: z.string().trim().min(5).max(2_000),
    risk_level: z.enum(['low', 'medium', 'high', 'critical']),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.evidence_ids.length === 0 && !['high', 'critical'].includes(value.risk_level)) {
      context.addIssue({
        code: 'custom',
        message: 'Topics without evidence must be high or critical risk',
        path: ['risk_level'],
      });
    }
  });

export const TopicPlannerDataSchema = z
  .object({ topics: z.array(TopicCandidateOutputSchema).min(1).max(50) })
  .strict();

export const TopicPlanRequestSchema = z
  .object({
    keyword_set_ids: UniqueUuidListSchema(20).min(1),
    max_topics: z.number().int().min(1).max(50).default(10),
    platform_codes: PlatformCodeListSchema,
    project_id: UuidSchema,
    seed_queries: UniqueTextListSchema(0, 20).default([]),
    workspace_id: UuidSchema,
  })
  .strict();

export const TopicCandidateQuerySchema = z
  .object({
    cursor: CursorSchema.optional(),
    generation_run_id: UuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    platform_code: z.enum(PLATFORM_CODES).optional(),
    project_id: UuidSchema.optional(),
    risk_level: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    status: z.enum(['proposed', 'adopted', 'archived']).optional(),
    workspace_id: UuidSchema.optional(),
  })
  .strict();

export const AdoptTopicRequestSchema = BriefFieldsSchema.partial()
  .strict()
  .superRefine((value, context) => {
    if (
      value.keyword_ids !== undefined &&
      value.primary_keyword_id !== undefined &&
      !value.keyword_ids.includes(value.primary_keyword_id)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Primary keyword must be included in keyword_ids',
        path: ['primary_keyword_id'],
      });
    }
  });

export const TopicCandidateIdSchema = UuidSchema;

export type BriefConstraints = z.infer<typeof BriefConstraintsSchema>;
export type TopicBriefSuggestion = z.infer<typeof TopicBriefSuggestionSchema>;
export type TopicCandidateOutput = z.infer<typeof TopicCandidateOutputSchema>;
export type TopicPlannerData = z.infer<typeof TopicPlannerDataSchema>;
export type TopicPlanRequest = z.infer<typeof TopicPlanRequestSchema>;
export type TopicCandidateQuery = z.infer<typeof TopicCandidateQuerySchema>;
export type AdoptTopicRequest = z.infer<typeof AdoptTopicRequestSchema>;

export interface GenerationRunView {
  readonly created_at: string;
  readonly error: Readonly<Record<string, unknown>> | null;
  readonly finished_at: string | null;
  readonly id: string;
  readonly input_hash: string;
  readonly model_key: string;
  readonly package_id: string | null;
  readonly project_id: string | null;
  readonly prompt_version_id: string;
  readonly request_id: string;
  readonly skill_name: string;
  readonly skill_version: string;
  readonly started_at: string | null;
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly tenant_id: string;
  readonly updated_at: string;
  readonly variant_id: string | null;
  readonly version: number;
  readonly workspace_id: string;
}

export interface TopicCandidateView {
  readonly brief_suggestion: TopicBriefSuggestion | null;
  readonly created_at: string;
  readonly entities: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly generation_run_id: string;
  readonly id: string;
  readonly intent: string;
  readonly platform_codes: readonly (typeof PLATFORM_CODES)[number][];
  readonly priority: number;
  readonly project_id: string;
  readonly question: string;
  readonly risk_level: 'low' | 'medium' | 'high' | 'critical';
  readonly status: 'proposed' | 'adopted' | 'archived';
  readonly tenant_id: string;
  readonly updated_at: string;
  readonly version: number;
  readonly workspace_id: string;
}

export interface TopicCandidatePage {
  readonly data: readonly TopicCandidateView[];
  readonly meta: { readonly next_cursor: string | null; readonly request_id: string };
}

export interface BriefView {
  readonly audience: string;
  readonly constraints: BriefConstraints;
  readonly created_at: string;
  readonly created_by: string;
  readonly due_at: string | null;
  readonly id: string;
  readonly keyword_ids: readonly string[];
  readonly objective: 'awareness' | 'conversion' | 'trust' | 'education';
  readonly platform_codes: readonly (typeof PLATFORM_CODES)[number][];
  readonly primary_keyword_id: string;
  readonly project_id: string;
  readonly source_ids: readonly string[];
  readonly source_topic_candidate_id: string | null;
  readonly tenant_id: string;
  readonly title: string;
  readonly updated_at: string;
  readonly version: number;
  readonly workspace_id: string;
}

function validatePrimaryKeyword(
  value: { readonly keyword_ids: readonly string[]; readonly primary_keyword_id: string },
  context: z.RefinementCtx,
): void {
  if (!value.keyword_ids.includes(value.primary_keyword_id)) {
    context.addIssue({
      code: 'custom',
      message: 'Primary keyword must be included in keyword_ids',
      path: ['primary_keyword_id'],
    });
  }
}
