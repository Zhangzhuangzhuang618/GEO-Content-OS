DO $$
DECLARE
  actor_created_by uuid;
  actor_published_by uuid;
  policy jsonb := '{
    "schema_version": "platform-rules@1",
    "platform_code": "douyin",
    "require_citations": true,
    "content_kind": "image_note",
    "title_min_characters": 2,
    "title_max_characters": 20,
    "card_count_min": 5,
    "card_count_max": 10,
    "declare_ai_generated": true,
    "declare_original": false
  }'::jsonb;
BEGIN
  SELECT created_by, COALESCE(published_by, created_by)
  INTO actor_created_by, actor_published_by
  FROM platform_rule_versions
  WHERE platform_code = 'douyin' AND status = 'published'
  ORDER BY published_at DESC NULLS LAST, created_at DESC, id DESC
  LIMIT 1;

  IF actor_created_by IS NOT NULL AND actor_published_by IS NOT NULL THEN
    UPDATE platform_rule_versions
    SET status = 'retired', lock_version = lock_version + 1
    WHERE platform_code = 'douyin' AND status = 'published';

    INSERT INTO platform_rule_versions (
      id, platform_code, version, rules_json, content_hash, status,
      created_by, published_at, change_summary, published_by
    ) VALUES (
      '26000000-0000-4000-8000-000000000012'::uuid,
      'douyin',
      '1.2.0',
      policy,
      encode(digest(convert_to(policy::text, 'UTF8'), 'sha256'), 'hex'),
      'published',
      actor_created_by,
      TIMESTAMPTZ '2026-09-05T06:30:00Z',
      'Align Douyin image-note titles with the Creator Center 20-character limit',
      actor_published_by
    );
  END IF;
END;
$$;
