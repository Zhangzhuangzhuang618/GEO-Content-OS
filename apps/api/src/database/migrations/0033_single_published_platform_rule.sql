WITH ranked_rules AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY platform_code
      ORDER BY published_at DESC NULLS LAST, created_at DESC, id DESC
    ) AS published_rank
  FROM platform_rule_versions
  WHERE status = 'published'
)
UPDATE platform_rule_versions AS rule
SET status = 'retired', lock_version = lock_version + 1
FROM ranked_rules
WHERE rule.id = ranked_rules.id
  AND ranked_rules.published_rank > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX platform_rule_versions_one_published_per_platform_uq
  ON platform_rule_versions (platform_code)
  WHERE status = 'published';
