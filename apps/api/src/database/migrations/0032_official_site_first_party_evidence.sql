WITH latest_quality_prompt AS (
  SELECT created_by, COALESCE(published_by, created_by) AS published_by
  FROM prompt_versions
  WHERE skill_name = 'quality-checker'
  ORDER BY published_at DESC NULLS LAST, created_at DESC, id DESC
  LIMIT 1
), prompt_policy AS (
  SELECT
    '企业已发布品牌档案是经授权确认的第一方来源。官网内容中与档案一致的经营事实不得仅因缺少公开 URL 被判定为无依据，也不得要求重复官方确认；第一方信息不得伪装成第三方证据。'::text AS system_prompt,
    '先核对内容是否与 brand_policy 精确一致。与档案一致的自有资源、服务范围和正式用工事实可按第一方信息通过；资质、认证、荣誉、监管口径、第三方统计、竞品比较、客户结果和超出档案的陈述仍按 platform_rules 要求证据。'::text AS task_template
)
INSERT INTO prompt_versions (
  id, skill_name, version, schema_version, system_prompt, task_template,
  content_hash, status, created_by, published_at, change_summary, published_by
)
SELECT
  '25000000-0000-4000-8000-000000000006'::uuid,
  'quality-checker',
  '1.1.0',
  'prompt@1',
  prompt_policy.system_prompt,
  prompt_policy.task_template,
  encode(
    digest(
      convert_to(prompt_policy.system_prompt || E'\n' || prompt_policy.task_template, 'UTF8'),
      'sha256'
    ),
    'hex'
  ),
  'published',
  latest_quality_prompt.created_by,
  TIMESTAMPTZ '2026-07-18T07:30:00Z',
  'Accept approved first-party operating facts for official-site quality checks',
  latest_quality_prompt.published_by
FROM latest_quality_prompt
CROSS JOIN prompt_policy
ON CONFLICT DO NOTHING;
--> statement-breakpoint
WITH latest_official_rule AS (
  SELECT created_by, COALESCE(published_by, created_by) AS published_by
  FROM platform_rule_versions
  WHERE platform_code = 'official_site'
  ORDER BY published_at DESC NULLS LAST, created_at DESC, id DESC
  LIMIT 1
), policy AS (
  SELECT '{
    "schema_version": "platform-rules@1",
    "platform_code": "official_site",
    "require_citations": false,
    "accepted_first_party_source": "published_brand_profile",
    "first_party_claims_require_public_citations": false,
    "require_citations_for_external_claims": true,
    "external_evidence_required_categories": [
      "licenses", "certifications", "awards", "regulated_claims",
      "third_party_statistics", "comparative_claims", "customer_outcomes"
    ]
  }'::jsonb AS rules
)
INSERT INTO platform_rule_versions (
  id, platform_code, version, rules_json, content_hash, status,
  created_by, published_at, change_summary, published_by
)
SELECT
  '26000000-0000-4000-8000-000000000008'::uuid,
  'official_site',
  '1.1.0',
  policy.rules,
  encode(digest(convert_to(policy.rules::text, 'UTF8'), 'sha256'), 'hex'),
  'published',
  latest_official_rule.created_by,
  TIMESTAMPTZ '2026-07-18T07:30:00Z',
  'Accept approved first-party operating facts without requiring a public citation',
  latest_official_rule.published_by
FROM latest_official_rule
CROSS JOIN policy
ON CONFLICT DO NOTHING;
