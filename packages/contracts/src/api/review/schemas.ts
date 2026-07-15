import { z } from 'zod';

import { PLATFORM_CODES } from '../../platforms.js';
import { TENANT_ROLE_CODES } from '../../roles.js';
import {
  CursorPageMetaSchema,
  CursorSchema,
  IsoDateTimeSchema,
  UuidSchema,
  VersionSchema,
  createDataResponseSchema,
} from '../common.js';

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const JsonObjectSchema = z.record(z.string(), z.unknown());
const UniqueVariantIdsSchema = z
  .array(UuidSchema)
  .min(1)
  .max(PLATFORM_CODES.length)
  .refine((values) => new Set(values).size === values.length, {
    message: 'variant_ids must be unique',
  });

export const ReviewSnapshotParamsSchema = z.object({ id: UuidSchema }).strict();
export const SubmitReviewRequestSchema = z.object({ variant_ids: UniqueVariantIdsSchema }).strict();
export const ReviewDecisionRequestSchema = z
  .object({
    comment: z.string().trim().min(1).max(4_000).nullable().default(null),
    variant_ids: UniqueVariantIdsSchema,
  })
  .strict();
export const RequestSignoffRequestSchema = z
  .object({
    comment: z.string().trim().min(1).max(4_000).nullable().default(null),
    required_role: z.enum(TENANT_ROLE_CODES).optional(),
    required_user_id: UuidSchema.optional(),
    variant_id: UuidSchema,
  })
  .strict()
  .refine(
    (value) => (value.required_role === undefined) !== (value.required_user_id === undefined),
    {
      message: 'Exactly one required_role or required_user_id is required',
      path: ['required_role'],
    },
  );
export const ReviewInboxQuerySchema = z
  .object({
    created_by: UuidSchema.optional(),
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    platform_code: z.enum(PLATFORM_CODES).optional(),
    project_id: UuidSchema.optional(),
    status: z.enum(['in_review', 'approved', 'rejected', 'superseded']).optional(),
    workspace_id: UuidSchema.optional(),
  })
  .strict();

export const ReviewCitationViewSchema = z
  .object({
    ai_citation_id: UuidSchema,
    citation_hash: HashSchema,
    created_at: IsoDateTimeSchema,
    id: UuidSchema,
    snapshot_variant_id: UuidSchema,
    tenant_id: UuidSchema,
  })
  .strict();
export const ReviewVariantViewSchema = z
  .object({
    citations: z.array(ReviewCitationViewSchema),
    content_hash: HashSchema,
    content_version_id: UuidSchema,
    created_at: IsoDateTimeSchema,
    id: UuidSchema,
    platform_code: z.enum(PLATFORM_CODES),
    platform_rule_version_id: UuidSchema,
    quality_report_id: UuidSchema,
    snapshot_id: UuidSchema,
    status: z.enum(['in_review', 'approved', 'rejected']),
    tenant_id: UuidSchema,
    variant_id: UuidSchema,
  })
  .strict();
export const ReviewRequirementViewSchema = z
  .object({
    completed_at: IsoDateTimeSchema.nullable(),
    created_at: IsoDateTimeSchema,
    id: UuidSchema,
    requested_by: UuidSchema,
    required_role: z.enum(TENANT_ROLE_CODES).nullable(),
    required_user_id: UuidSchema.nullable(),
    snapshot_id: UuidSchema,
    status: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
    tenant_id: UuidSchema,
    updated_at: IsoDateTimeSchema,
    variant_id: UuidSchema.nullable(),
  })
  .strict();
export const ReviewActionViewSchema = z
  .object({
    action: z.enum(['approve', 'reject', 'request_signoff', 'comment']),
    comment: z.string().nullable(),
    created_at: IsoDateTimeSchema,
    id: UuidSchema,
    reviewer_id: UuidSchema,
    snapshot_id: UuidSchema,
    tenant_id: UuidSchema,
    variant_ids: z.array(UuidSchema).max(PLATFORM_CODES.length),
  })
  .strict();
export const ReviewSnapshotViewSchema = z
  .object({
    brand_profile_id: UuidSchema,
    created_at: IsoDateTimeSchema,
    created_by: UuidSchema,
    id: UuidSchema,
    model_key: z.string().min(1).max(80),
    package_id: UuidSchema,
    platform_rules_hash: HashSchema,
    prompt_version_id: UuidSchema,
    quality_rules_hash: HashSchema,
    requirements: z.array(ReviewRequirementViewSchema),
    snapshot_hash: HashSchema,
    status: z.enum(['in_review', 'approved', 'rejected', 'superseded']),
    tenant_id: UuidSchema,
    updated_at: IsoDateTimeSchema,
    variants: z.array(ReviewVariantViewSchema).min(1).max(PLATFORM_CODES.length),
    version: VersionSchema,
  })
  .strict();

export const ReviewInboxItemSchema = ReviewSnapshotViewSchema.omit({
  requirements: true,
  variants: true,
}).extend({
  pending_signoff_count: z.number().int().nonnegative(),
  platform_codes: z.array(z.enum(PLATFORM_CODES)).min(1).max(PLATFORM_CODES.length),
  project_id: UuidSchema,
  variant_count: z.number().int().min(1).max(PLATFORM_CODES.length),
  workspace_id: UuidSchema,
});

const FrozenCitationDetailSchema = z
  .object({
    ai_citation_id: UuidSchema,
    chunk_id: UuidSchema,
    claim_key: z.string(),
    claim_text: z.string(),
    quote_hash: HashSchema,
    quote_text: z.string(),
  })
  .strict();
const FrozenVariantDetailSchema = z
  .object({
    citations: z.array(FrozenCitationDetailSchema),
    content_json: JsonObjectSchema,
    platform_code: z.enum(PLATFORM_CODES),
    platform_rule: z
      .object({
        content_hash: HashSchema,
        id: UuidSchema,
        rules_json: JsonObjectSchema,
        version: z.string(),
      })
      .strict(),
    quality_report: z
      .object({
        checker_version: z.string(),
        decision: z.literal('pass'),
        geo_scores_json: JsonObjectSchema,
        id: UuidSchema,
        issues_json: JsonObjectSchema,
        score: z.number().min(0).max(100),
      })
      .strict(),
    schema_version: z.string(),
    snapshot_variant_id: UuidSchema,
  })
  .strict();
export const ReviewSnapshotDetailSchema = z
  .object({
    actions: z.array(ReviewActionViewSchema),
    brand_profile: z
      .object({
        id: UuidSchema,
        profile_json: JsonObjectSchema,
        schema_version: z.string(),
        version: VersionSchema,
      })
      .strict(),
    prompt_version: z
      .object({
        content_hash: HashSchema,
        id: UuidSchema,
        schema_version: z.string(),
        skill_name: z.string(),
        version: z.string(),
      })
      .strict(),
    snapshot: ReviewSnapshotViewSchema,
    variants: z.array(FrozenVariantDetailSchema).min(1).max(PLATFORM_CODES.length),
  })
  .strict();

export const ReviewSnapshotResponseSchema = createDataResponseSchema(ReviewSnapshotViewSchema);
export const ReviewSnapshotDetailResponseSchema = createDataResponseSchema(
  ReviewSnapshotDetailSchema,
);
export const ReviewRequirementResponseSchema = createDataResponseSchema(
  ReviewRequirementViewSchema,
);
export const ReviewSnapshotPageSchema = z
  .object({ data: z.array(ReviewInboxItemSchema), meta: CursorPageMetaSchema })
  .strict();
export const ReviewActionPageSchema = z
  .object({
    data: z.array(ReviewActionViewSchema),
    meta: z.object({ request_id: z.string().min(1) }).strict(),
  })
  .strict();

export type ReviewInboxQuery = z.infer<typeof ReviewInboxQuerySchema>;
export type ReviewDecisionRequest = z.infer<typeof ReviewDecisionRequestSchema>;
export type RequestSignoffRequest = z.infer<typeof RequestSignoffRequestSchema>;
export type SubmitReviewRequest = z.infer<typeof SubmitReviewRequestSchema>;
