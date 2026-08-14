import { z } from 'zod';

const Uuid = z.string().uuid();
const Hash = z.string().regex(/^[0-9a-f]{64}$/u);
const DateTime = z.iso.datetime();
const Platform = z.enum([
  'official_site',
  'baijiahao',
  'sohu',
  'lieju',
  'toutiao',
  'zhihu',
  'xiaohongshu',
  'wechat_mp',
  'douyin',
]);
const Requirement = z
  .object({
    completed_at: DateTime.nullable(),
    created_at: DateTime,
    id: Uuid,
    requested_by: Uuid,
    required_role: z.string().nullable(),
    required_user_id: Uuid.nullable(),
    snapshot_id: Uuid,
    status: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
    tenant_id: Uuid,
    updated_at: DateTime,
    variant_id: Uuid.nullable(),
  })
  .strict();
const Action = z
  .object({
    action: z.enum(['approve', 'reject', 'request_signoff', 'comment']),
    comment: z.string().nullable(),
    created_at: DateTime,
    id: Uuid,
    reviewer_id: Uuid,
    snapshot_id: Uuid,
    tenant_id: Uuid,
    variant_ids: z.array(Uuid),
  })
  .strict();
const SnapshotVariant = z
  .object({
    citations: z.array(
      z
        .object({
          ai_citation_id: Uuid,
          citation_hash: Hash,
          created_at: DateTime,
          id: Uuid,
          snapshot_variant_id: Uuid,
          tenant_id: Uuid,
        })
        .strict(),
    ),
    content_hash: Hash,
    content_version_id: Uuid,
    created_at: DateTime,
    id: Uuid,
    platform_code: Platform,
    platform_rule_version_id: Uuid,
    quality_report_id: Uuid,
    snapshot_id: Uuid,
    status: z.enum(['in_review', 'approved', 'rejected']),
    tenant_id: Uuid,
    variant_id: Uuid,
  })
  .strict();
const Snapshot = z
  .object({
    brand_profile_id: Uuid,
    created_at: DateTime,
    created_by: Uuid,
    id: Uuid,
    model_key: z.string(),
    package_id: Uuid,
    platform_rules_hash: Hash,
    prompt_version_id: Uuid,
    quality_rules_hash: Hash,
    requirements: z.array(Requirement),
    snapshot_hash: Hash,
    status: z.enum(['in_review', 'approved', 'rejected', 'superseded']),
    tenant_id: Uuid,
    updated_at: DateTime,
    variants: z.array(SnapshotVariant),
    version: z.number().int().positive(),
  })
  .strict();
const FrozenVariant = z
  .object({
    citations: z.array(
      z
        .object({
          ai_citation_id: Uuid,
          chunk_id: Uuid,
          claim_key: z.string(),
          claim_text: z.string(),
          quote_hash: Hash,
          quote_text: z.string(),
        })
        .strict(),
    ),
    content_json: z.record(z.string(), z.unknown()),
    platform_code: Platform,
    platform_rule: z
      .object({
        content_hash: Hash,
        id: Uuid,
        rules_json: z.record(z.string(), z.unknown()),
        version: z.string(),
      })
      .strict(),
    quality_report: z
      .object({
        checker_version: z.string(),
        decision: z.literal('pass'),
        geo_scores_json: z.record(z.string(), z.unknown()),
        id: Uuid,
        issues_json: z.record(z.string(), z.unknown()),
        score: z.number(),
      })
      .strict(),
    schema_version: z.string(),
    snapshot_variant_id: Uuid,
  })
  .strict();

export const ReviewSnapshotDetailSchema = z
  .object({
    actions: z.array(Action),
    brand_profile: z
      .object({
        id: Uuid,
        profile_json: z.record(z.string(), z.unknown()),
        schema_version: z.string(),
        version: z.number().int().positive(),
      })
      .strict(),
    prompt_version: z
      .object({
        content_hash: Hash,
        id: Uuid,
        schema_version: z.string(),
        skill_name: z.string(),
        version: z.string(),
      })
      .strict(),
    snapshot: Snapshot,
    variants: z.array(FrozenVariant),
  })
  .strict();
export const ReviewSnapshotResponseSchema = z
  .object({
    data: ReviewSnapshotDetailSchema,
    meta: z.object({ request_id: z.string() }).passthrough(),
  })
  .strict();
export const RequirementResponseSchema = z
  .object({ data: Requirement, meta: z.object({ request_id: z.string() }).passthrough() })
  .strict();

export type ReviewSnapshotDetail = z.infer<typeof ReviewSnapshotDetailSchema>;
export type SnapshotVariant = z.infer<typeof SnapshotVariant>;
