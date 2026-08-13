CREATE OR REPLACE FUNCTION is_valid_platform_code_array(input_codes varchar[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT
    cardinality(input_codes) BETWEEN 1 AND 8
    AND array_position(input_codes, NULL) IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM unnest(input_codes) AS code
      WHERE code NOT IN (
        'official_site', 'baijiahao', 'sohu', 'toutiao', 'zhihu',
        'xiaohongshu', 'wechat_mp', 'douyin'
      )
    )
    AND cardinality(input_codes) = (
      SELECT count(DISTINCT code)::integer FROM unnest(input_codes) AS code
    );
$$;
--> statement-breakpoint
ALTER TABLE content_variants DROP CONSTRAINT content_variants_platform_check,
  ADD CONSTRAINT content_variants_platform_check CHECK (
    platform_code IN (
      'official_site', 'baijiahao', 'sohu', 'toutiao', 'zhihu',
      'xiaohongshu', 'wechat_mp', 'douyin'
    )
  );
--> statement-breakpoint
ALTER TABLE platform_accounts DROP CONSTRAINT platform_accounts_platform_check,
  ADD CONSTRAINT platform_accounts_platform_check CHECK (
    platform_code IN (
      'official_site', 'baijiahao', 'sohu', 'toutiao', 'zhihu',
      'xiaohongshu', 'wechat_mp', 'douyin'
    )
  );
--> statement-breakpoint
ALTER TABLE metric_records DROP CONSTRAINT metric_records_platform_check,
  ADD CONSTRAINT metric_records_platform_check CHECK (
    platform_code IN (
      'official_site', 'baijiahao', 'sohu', 'toutiao', 'zhihu',
      'xiaohongshu', 'wechat_mp', 'douyin'
    )
  );
--> statement-breakpoint
ALTER TABLE visibility_observations DROP CONSTRAINT visibility_observations_platform_check,
  ADD CONSTRAINT visibility_observations_platform_check CHECK (
    platform_code IN (
      'official_site', 'baijiahao', 'sohu', 'toutiao', 'zhihu',
      'xiaohongshu', 'wechat_mp', 'douyin'
    )
  );
--> statement-breakpoint
ALTER TABLE platform_rule_versions DROP CONSTRAINT platform_rule_versions_platform_check,
  ADD CONSTRAINT platform_rule_versions_platform_check CHECK (
    platform_code IN (
      'official_site', 'baijiahao', 'sohu', 'toutiao', 'zhihu',
      'xiaohongshu', 'wechat_mp', 'douyin'
    )
  );
--> statement-breakpoint
ALTER TABLE content_media_runs DROP CONSTRAINT content_media_runs_platform_check,
  ADD CONSTRAINT content_media_runs_platform_check
    CHECK (platform_code IN ('official_site', 'baijiahao', 'sohu'));
--> statement-breakpoint
WITH latest_rule_actor AS (
  SELECT created_by, COALESCE(published_by, created_by) AS published_by
  FROM platform_rule_versions
  ORDER BY published_at DESC NULLS LAST, created_at DESC, id DESC
  LIMIT 1
), sohu_policy AS (
  SELECT '{
    "schema_version": "platform-rules@1",
    "platform_code": "sohu",
    "require_citations": true,
    "title_min_characters": 5,
    "title_max_characters": 72,
    "abstract_max_characters": 120,
    "declare_ai_generated": true,
    "declare_original": false
  }'::jsonb AS rules
)
INSERT INTO platform_rule_versions (
  id, platform_code, version, rules_json, content_hash, status,
  created_by, published_at, change_summary, published_by
)
SELECT
  '26000000-0000-4000-8000-000000000009'::uuid,
  'sohu',
  '1.0.0',
  sohu_policy.rules,
  encode(digest(convert_to(sohu_policy.rules::text, 'UTF8'), 'sha256'), 'hex'),
  'published',
  latest_rule_actor.created_by,
  TIMESTAMPTZ '2026-08-14T00:00:00Z',
  'Add Sohu article generation and managed browser publishing rules',
  latest_rule_actor.published_by
FROM latest_rule_actor
CROSS JOIN sohu_policy
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE sohu_browser_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'login_required',
  profile_key varchar(200) NOT NULL,
  storage_state_ciphertext text,
  storage_state_key_version varchar(32),
  page_signature varchar(128),
  qr_expires_at timestamptz,
  authenticated_at timestamptz,
  last_verified_at timestamptz,
  last_error_json jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sohu_browser_sessions_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT sohu_browser_sessions_account_uq UNIQUE (tenant_id, account_id),
  CONSTRAINT sohu_browser_sessions_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT sohu_browser_sessions_account_fk
    FOREIGN KEY (account_id, tenant_id)
    REFERENCES platform_accounts(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT sohu_browser_sessions_status_check CHECK (
    status IN (
      'login_required', 'qr_ready', 'authenticated', 'reauth',
      'attention_required', 'disabled'
    )
  ),
  CONSTRAINT sohu_browser_sessions_profile_key_check CHECK (
    profile_key ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$'
    AND profile_key !~ '(^|/)\.\.(/|$)'
  ),
  CONSTRAINT sohu_browser_sessions_credentials_check CHECK (
    (storage_state_ciphertext IS NULL) = (storage_state_key_version IS NULL)
  ),
  CONSTRAINT sohu_browser_sessions_error_check CHECK (
    last_error_json IS NULL OR jsonb_typeof(last_error_json) = 'object'
  ),
  CONSTRAINT sohu_browser_sessions_version_check CHECK (version > 0)
);
--> statement-breakpoint
CREATE INDEX sohu_browser_sessions_status_idx
  ON sohu_browser_sessions (status, updated_at, id);
--> statement-breakpoint
CREATE TRIGGER sohu_browser_sessions_set_updated_at
  BEFORE UPDATE ON sohu_browser_sessions FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE FUNCTION enforce_sohu_browser_session_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM platform_accounts AS account
    WHERE account.id = NEW.account_id AND account.tenant_id = NEW.tenant_id
      AND account.platform_code = 'sohu' AND account.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'browser session account must be a scoped sohu account';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sohu_browser_sessions_scope_guard
  BEFORE INSERT OR UPDATE OF tenant_id, account_id ON sohu_browser_sessions
  FOR EACH ROW EXECUTE FUNCTION enforce_sohu_browser_session_scope();
--> statement-breakpoint
CREATE TABLE sohu_browser_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  account_id uuid NOT NULL,
  publish_job_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  idempotency_key varchar(160) NOT NULL,
  payload_hash char(64) NOT NULL,
  content_fingerprint char(64) NOT NULL,
  title varchar(120) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'prepared',
  external_post_id varchar(240),
  external_url text,
  review_reason text,
  field_summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_at timestamptz,
  last_reconciled_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sohu_browser_publications_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT sohu_browser_publications_job_uq UNIQUE (tenant_id, publish_job_id),
  CONSTRAINT sohu_browser_publications_idempotency_uq UNIQUE (tenant_id, account_id, idempotency_key),
  CONSTRAINT sohu_browser_publications_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT sohu_browser_publications_session_fk
    FOREIGN KEY (session_id, tenant_id)
    REFERENCES sohu_browser_sessions(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT sohu_browser_publications_account_fk
    FOREIGN KEY (account_id, tenant_id)
    REFERENCES platform_accounts(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT sohu_browser_publications_publish_job_fk
    FOREIGN KEY (publish_job_id, tenant_id)
    REFERENCES publish_jobs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT sohu_browser_publications_content_version_fk
    FOREIGN KEY (content_version_id, tenant_id)
    REFERENCES content_versions(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT sohu_browser_publications_hash_check CHECK (
    payload_hash ~ '^[0-9a-f]{64}$' AND content_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT sohu_browser_publications_title_check CHECK (
    char_length(btrim(title)) BETWEEN 5 AND 72
  ),
  CONSTRAINT sohu_browser_publications_status_check CHECK (
    status IN (
      'prepared', 'submitting', 'unknown', 'processing',
      'published', 'failed', 'manual_required'
    )
  ),
  CONSTRAINT sohu_browser_publications_summary_check CHECK (
    jsonb_typeof(field_summary_json) = 'object'
  ),
  CONSTRAINT sohu_browser_publications_version_check CHECK (version > 0)
);
--> statement-breakpoint
CREATE INDEX sohu_browser_publications_reconcile_idx
  ON sohu_browser_publications (status, last_reconciled_at, created_at, id)
  WHERE status IN ('submitting', 'unknown', 'processing');
--> statement-breakpoint
CREATE TRIGGER sohu_browser_publications_set_updated_at
  BEFORE UPDATE ON sohu_browser_publications FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE sohu_browser_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  publication_id uuid NOT NULL,
  kind varchar(32) NOT NULL,
  object_uri text NOT NULL,
  content_hash char(64) NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sohu_browser_artifacts_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT sohu_browser_artifacts_object_uq UNIQUE (tenant_id, object_uri),
  CONSTRAINT sohu_browser_artifacts_publication_fk
    FOREIGN KEY (publication_id, tenant_id)
    REFERENCES sohu_browser_publications(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT sohu_browser_artifacts_kind_check CHECK (
    kind IN ('pre_submit', 'post_submit', 'reconcile', 'attention_required')
  ),
  CONSTRAINT sohu_browser_artifacts_uri_check CHECK (
    char_length(btrim(object_uri)) BETWEEN 1 AND 2000
  ),
  CONSTRAINT sohu_browser_artifacts_hash_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sohu_browser_artifacts_metadata_check CHECK (jsonb_typeof(metadata_json) = 'object')
);
--> statement-breakpoint
CREATE INDEX sohu_browser_artifacts_publication_idx
  ON sohu_browser_artifacts (tenant_id, publication_id, created_at, id);
