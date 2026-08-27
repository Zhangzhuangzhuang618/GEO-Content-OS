ALTER TABLE publish_jobs
  DROP CONSTRAINT publish_jobs_origin_check,
  ADD CONSTRAINT publish_jobs_origin_check CHECK (
    origin IN (
      'manual', 'official_site_automation', 'baijiahao_automation',
      'sohu_automation', 'lieju_automation', 'douyin_automation'
    )
  );
--> statement-breakpoint
ALTER TABLE content_media_runs
  DROP CONSTRAINT content_media_runs_platform_check,
  ADD CONSTRAINT content_media_runs_platform_check
    CHECK (platform_code IN ('official_site', 'baijiahao', 'sohu', 'lieju', 'douyin'));
--> statement-breakpoint
ALTER TABLE browser_platform_automation_policies
  DROP CONSTRAINT browser_platform_automation_policies_platform_check,
  ADD CONSTRAINT browser_platform_automation_policies_platform_check
    CHECK (platform_code IN ('sohu', 'lieju', 'douyin'));
--> statement-breakpoint
ALTER TABLE browser_platform_automation_runs
  DROP CONSTRAINT browser_platform_automation_runs_platform_check,
  ADD CONSTRAINT browser_platform_automation_runs_platform_check
    CHECK (platform_code IN ('sohu', 'lieju', 'douyin'));
--> statement-breakpoint
UPDATE platform_rule_versions
SET status = 'retired'
WHERE platform_code = 'douyin' AND status = 'published';
--> statement-breakpoint
WITH latest_rule_actor AS (
  SELECT created_by, COALESCE(published_by, created_by) AS published_by
  FROM platform_rule_versions
  ORDER BY published_at DESC NULLS LAST, created_at DESC, id DESC
  LIMIT 1
), douyin_policy AS (
  SELECT '{
    "schema_version": "platform-rules@1",
    "platform_code": "douyin",
    "require_citations": true,
    "content_kind": "image_note",
    "title_min_characters": 2,
    "title_max_characters": 30,
    "card_count_min": 5,
    "card_count_max": 10,
    "declare_ai_generated": true,
    "declare_original": false
  }'::jsonb AS rules
)
INSERT INTO platform_rule_versions (
  id, platform_code, version, rules_json, content_hash, status,
  created_by, published_at, change_summary, published_by
)
SELECT
  '26000000-0000-4000-8000-000000000011'::uuid,
  'douyin',
  '1.1.0',
  douyin_policy.rules,
  encode(digest(convert_to(douyin_policy.rules::text, 'UTF8'), 'sha256'), 'hex'),
  'published',
  latest_rule_actor.created_by,
  TIMESTAMPTZ '2026-08-26T00:00:00Z',
  'Add Douyin image-note generation and managed browser publishing rules',
  latest_rule_actor.published_by
FROM latest_rule_actor
CROSS JOIN douyin_policy
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE douyin_browser_sessions (
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
  CONSTRAINT douyin_browser_sessions_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT douyin_browser_sessions_account_uq UNIQUE (tenant_id, account_id),
  CONSTRAINT douyin_browser_sessions_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT douyin_browser_sessions_account_fk
    FOREIGN KEY (account_id, tenant_id)
    REFERENCES platform_accounts(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT douyin_browser_sessions_status_check CHECK (
    status IN (
      'login_required', 'qr_ready', 'authenticated', 'reauth',
      'attention_required', 'disabled'
    )
  ),
  CONSTRAINT douyin_browser_sessions_profile_key_check CHECK (
    profile_key ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$'
    AND profile_key !~ '(^|/)\.\.(/|$)'
  ),
  CONSTRAINT douyin_browser_sessions_credentials_check CHECK (
    (storage_state_ciphertext IS NULL) = (storage_state_key_version IS NULL)
  ),
  CONSTRAINT douyin_browser_sessions_error_check CHECK (
    last_error_json IS NULL OR jsonb_typeof(last_error_json) = 'object'
  ),
  CONSTRAINT douyin_browser_sessions_version_check CHECK (version > 0)
);
--> statement-breakpoint
CREATE INDEX douyin_browser_sessions_status_idx
  ON douyin_browser_sessions (status, updated_at, id);
--> statement-breakpoint
CREATE TRIGGER douyin_browser_sessions_set_updated_at
  BEFORE UPDATE ON douyin_browser_sessions FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE FUNCTION enforce_douyin_browser_session_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM platform_accounts AS account
    WHERE account.id = NEW.account_id AND account.tenant_id = NEW.tenant_id
      AND account.platform_code = 'douyin' AND account.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'browser session account must be a scoped douyin account';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER douyin_browser_sessions_scope_guard
  BEFORE INSERT OR UPDATE OF tenant_id, account_id ON douyin_browser_sessions
  FOR EACH ROW EXECUTE FUNCTION enforce_douyin_browser_session_scope();
--> statement-breakpoint
CREATE TABLE douyin_browser_publications (
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
  CONSTRAINT douyin_browser_publications_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT douyin_browser_publications_job_uq UNIQUE (tenant_id, publish_job_id),
  CONSTRAINT douyin_browser_publications_idempotency_uq
    UNIQUE (tenant_id, account_id, idempotency_key),
  CONSTRAINT douyin_browser_publications_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT douyin_browser_publications_session_fk
    FOREIGN KEY (session_id, tenant_id)
    REFERENCES douyin_browser_sessions(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT douyin_browser_publications_account_fk
    FOREIGN KEY (account_id, tenant_id)
    REFERENCES platform_accounts(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT douyin_browser_publications_publish_job_fk
    FOREIGN KEY (publish_job_id, tenant_id)
    REFERENCES publish_jobs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT douyin_browser_publications_content_version_fk
    FOREIGN KEY (content_version_id, tenant_id)
    REFERENCES content_versions(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT douyin_browser_publications_hash_check CHECK (
    payload_hash ~ '^[0-9a-f]{64}$' AND content_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT douyin_browser_publications_title_check CHECK (
    char_length(btrim(title)) BETWEEN 2 AND 30
  ),
  CONSTRAINT douyin_browser_publications_status_check CHECK (
    status IN (
      'prepared', 'submitting', 'unknown', 'processing',
      'published', 'failed', 'manual_required'
    )
  ),
  CONSTRAINT douyin_browser_publications_summary_check CHECK (
    jsonb_typeof(field_summary_json) = 'object'
  ),
  CONSTRAINT douyin_browser_publications_version_check CHECK (version > 0)
);
--> statement-breakpoint
CREATE INDEX douyin_browser_publications_reconcile_idx
  ON douyin_browser_publications (status, last_reconciled_at, created_at, id)
  WHERE status IN ('submitting', 'unknown', 'processing');
--> statement-breakpoint
CREATE TRIGGER douyin_browser_publications_set_updated_at
  BEFORE UPDATE ON douyin_browser_publications FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE douyin_browser_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  publication_id uuid NOT NULL,
  kind varchar(32) NOT NULL,
  object_uri text NOT NULL,
  content_hash char(64) NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT douyin_browser_artifacts_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT douyin_browser_artifacts_object_uq UNIQUE (tenant_id, object_uri),
  CONSTRAINT douyin_browser_artifacts_publication_fk
    FOREIGN KEY (publication_id, tenant_id)
    REFERENCES douyin_browser_publications(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT douyin_browser_artifacts_kind_check CHECK (
    kind IN ('pre_submit', 'post_submit', 'reconcile', 'attention_required')
  ),
  CONSTRAINT douyin_browser_artifacts_uri_check CHECK (
    char_length(btrim(object_uri)) BETWEEN 1 AND 2000
  ),
  CONSTRAINT douyin_browser_artifacts_hash_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT douyin_browser_artifacts_metadata_check CHECK (jsonb_typeof(metadata_json) = 'object')
);
--> statement-breakpoint
CREATE INDEX douyin_browser_artifacts_publication_idx
  ON douyin_browser_artifacts (tenant_id, publication_id, created_at, id);
