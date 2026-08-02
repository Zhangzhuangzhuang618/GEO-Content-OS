ALTER TABLE publish_jobs
  DROP CONSTRAINT publish_jobs_origin_check,
  ADD CONSTRAINT publish_jobs_origin_check
    CHECK (origin IN ('manual', 'official_site_automation', 'baijiahao_automation'));
--> statement-breakpoint
ALTER TABLE quality_reports
  DROP CONSTRAINT quality_reports_automation_gate_check,
  ADD CONSTRAINT quality_reports_automation_gate_check CHECK (
    automation_gate_json IS NULL OR COALESCE(
      jsonb_typeof(automation_gate_json) = 'object'
      AND automation_gate_json->>'schema_version' IN (
        'official-site-quality-gate@1',
        'baijiahao-quality-gate@1'
      )
      AND automation_gate_json ?& ARRAY[
        'schema_version', 'passed', 'blocking_rules', 'geo_total',
        'factual_accuracy', 'brand_consistency', 'readability_safety',
        'question_coverage', 'platform_fit'
      ]::text[]
      AND jsonb_typeof(automation_gate_json->'passed') = 'boolean'
      AND jsonb_typeof(automation_gate_json->'blocking_rules') = 'array'
      AND (automation_gate_json->>'geo_total')::numeric BETWEEN 0 AND 100
      AND (automation_gate_json->>'factual_accuracy')::numeric BETWEEN 0 AND 100
      AND (automation_gate_json->>'brand_consistency')::numeric BETWEEN 0 AND 100
      AND (automation_gate_json->>'readability_safety')::numeric BETWEEN 0 AND 100
      AND (automation_gate_json->>'question_coverage')::numeric BETWEEN 0 AND 100
      AND (automation_gate_json->>'platform_fit')::numeric BETWEEN 0 AND 100,
      false
    )
  );
--> statement-breakpoint
CREATE TABLE baijiahao_automation_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  account_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  source_mode varchar(32) NOT NULL DEFAULT 'official_site_derived',
  independent_fallback_enabled boolean NOT NULL DEFAULT false,
  daily_enabled boolean NOT NULL DEFAULT false,
  daily_target_count smallint NOT NULL DEFAULT 1,
  daily_candidate_limit smallint NOT NULL DEFAULT 3,
  daily_generation_time time NOT NULL DEFAULT TIME '00:30',
  daily_timezone varchar(64) NOT NULL DEFAULT 'Asia/Shanghai',
  daily_schedule_times time[] NOT NULL DEFAULT ARRAY[TIME '10:00'],
  max_source_similarity numeric(5,4) NOT NULL DEFAULT 0.8200,
  geo_total_min smallint NOT NULL DEFAULT 85,
  factual_accuracy_min smallint NOT NULL DEFAULT 90,
  brand_consistency_min smallint NOT NULL DEFAULT 90,
  readability_safety_min smallint NOT NULL DEFAULT 85,
  question_coverage_min smallint NOT NULL DEFAULT 80,
  platform_fit_min smallint NOT NULL DEFAULT 80,
  max_rewrites smallint NOT NULL DEFAULT 3,
  publish_attempt_limit smallint NOT NULL DEFAULT 3,
  version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT baijiahao_automation_policies_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT baijiahao_automation_policies_project_uq UNIQUE (tenant_id, project_id),
  CONSTRAINT baijiahao_automation_policies_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_automation_policies_project_fk
    FOREIGN KEY (project_id, tenant_id, workspace_id)
    REFERENCES projects(id, tenant_id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_automation_policies_account_fk
    FOREIGN KEY (account_id, tenant_id)
    REFERENCES platform_accounts(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_automation_policies_created_by_fk
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_automation_policies_membership_fk
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_automation_policies_source_mode_check CHECK (
    source_mode IN ('official_site_derived', 'independent')
  ),
  CONSTRAINT baijiahao_automation_policies_fallback_check CHECK (
    NOT independent_fallback_enabled OR source_mode = 'official_site_derived'
  ),
  CONSTRAINT baijiahao_automation_policies_thresholds_check CHECK (
    geo_total_min = 85
    AND factual_accuracy_min = 90
    AND brand_consistency_min = 90
    AND readability_safety_min = 85
    AND question_coverage_min = 80
    AND platform_fit_min = 80
  ),
  CONSTRAINT baijiahao_automation_policies_limits_check CHECK (
    max_rewrites = 3 AND publish_attempt_limit = 3
  ),
  CONSTRAINT baijiahao_automation_policies_daily_check CHECK (
    daily_target_count BETWEEN 1 AND 10
    AND daily_candidate_limit BETWEEN daily_target_count AND 30
    AND cardinality(daily_schedule_times) = daily_target_count
    AND daily_timezone = 'Asia/Shanghai'
    AND (NOT daily_enabled OR enabled)
  ),
  CONSTRAINT baijiahao_automation_policies_similarity_check CHECK (
    max_source_similarity = 0.8200
  ),
  CONSTRAINT baijiahao_automation_policies_version_check CHECK (version > 0)
);
--> statement-breakpoint
CREATE INDEX baijiahao_automation_policies_enabled_idx
  ON baijiahao_automation_policies (tenant_id, workspace_id, enabled, project_id)
  WHERE enabled;
--> statement-breakpoint
CREATE TRIGGER baijiahao_automation_policies_set_updated_at
  BEFORE UPDATE ON baijiahao_automation_policies
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE FUNCTION enforce_baijiahao_automation_policy_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM platform_accounts AS account
    WHERE account.id = NEW.account_id
      AND account.tenant_id = NEW.tenant_id
      AND account.workspace_id = NEW.workspace_id
      AND account.platform_code = 'baijiahao'
      AND account.deleted_at IS NULL
      AND (
        NOT NEW.enabled
        OR (account.status = 'active' AND account.publish_mode = 'api')
      )
  ) THEN
    RAISE EXCEPTION 'baijiahao automation account must be an active-scope baijiahao api account';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER baijiahao_automation_policies_scope_guard
  BEFORE INSERT OR UPDATE OF tenant_id, workspace_id, project_id, account_id, enabled
  ON baijiahao_automation_policies
  FOR EACH ROW
  EXECUTE FUNCTION enforce_baijiahao_automation_policy_scope();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_variant_brief_platform()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM content_packages AS package
    JOIN briefs AS brief
      ON brief.id = package.brief_id AND brief.tenant_id = package.tenant_id
    WHERE
      package.id = NEW.package_id
      AND package.tenant_id = NEW.tenant_id
      AND (
        NEW.platform_code = ANY(brief.platform_codes)
        OR (
          NEW.platform_code = 'baijiahao'
          AND NOT NEW.is_required
          AND NEW.platform_account_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM baijiahao_automation_policies AS policy
            WHERE policy.tenant_id = package.tenant_id
              AND policy.workspace_id = package.workspace_id
              AND policy.project_id = package.project_id
              AND policy.account_id = NEW.platform_account_id
              AND policy.enabled
              AND policy.source_mode = 'official_site_derived'
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'content variant platform is not selected by its brief';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TABLE baijiahao_automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  source_mode varchar(32) NOT NULL,
  source_content_version_id uuid,
  source_publish_job_id uuid,
  source_url text,
  source_provenance_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  variant_id uuid,
  content_version_id uuid,
  status varchar(32) NOT NULL DEFAULT 'adaptation_pending',
  rewrite_count smallint NOT NULL DEFAULT 0,
  source_similarity numeric(5,4),
  last_quality_report_id uuid,
  publish_job_id uuid,
  last_error_json jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT baijiahao_automation_runs_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT baijiahao_automation_runs_variant_uq UNIQUE (tenant_id, variant_id),
  CONSTRAINT baijiahao_automation_runs_publish_job_uq UNIQUE (tenant_id, publish_job_id),
  CONSTRAINT baijiahao_automation_runs_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_automation_runs_policy_fk
    FOREIGN KEY (policy_id, tenant_id)
    REFERENCES baijiahao_automation_policies(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_automation_runs_source_version_fk
    FOREIGN KEY (source_content_version_id, tenant_id)
    REFERENCES content_versions(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_automation_runs_source_publish_job_fk
    FOREIGN KEY (source_publish_job_id, tenant_id)
    REFERENCES publish_jobs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_automation_runs_variant_fk
    FOREIGN KEY (variant_id, tenant_id)
    REFERENCES content_variants(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_automation_runs_content_version_fk
    FOREIGN KEY (content_version_id, tenant_id)
    REFERENCES content_versions(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_automation_runs_quality_report_fk
    FOREIGN KEY (last_quality_report_id, tenant_id)
    REFERENCES quality_reports(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_automation_runs_publish_job_fk
    FOREIGN KEY (publish_job_id, tenant_id)
    REFERENCES publish_jobs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_automation_runs_source_mode_check CHECK (
    source_mode IN ('official_site_derived', 'independent')
  ),
  CONSTRAINT baijiahao_automation_runs_source_check CHECK (
    (
      source_mode = 'official_site_derived'
      AND source_content_version_id IS NOT NULL
      AND source_publish_job_id IS NOT NULL
      AND source_url ~* '^https?://'
    ) OR (
      source_mode = 'independent'
      AND source_content_version_id IS NULL
      AND source_publish_job_id IS NULL
      AND source_url IS NULL
    )
  ),
  CONSTRAINT baijiahao_automation_runs_provenance_check CHECK (
    jsonb_typeof(source_provenance_json) = 'object'
  ),
  CONSTRAINT baijiahao_automation_runs_status_check CHECK (
    status IN (
      'generation_pending', 'generating', 'adaptation_pending', 'adapting',
      'quality_pending', 'rewrite_pending',
      'rewriting', 'publish_pending', 'scheduled', 'publishing', 'processing',
      'published', 'skipped', 'manual_required', 'publish_failed', 'disabled'
    )
  ),
  CONSTRAINT baijiahao_automation_runs_variant_check CHECK (
    variant_id IS NOT NULL OR status = 'skipped'
  ),
  CONSTRAINT baijiahao_automation_runs_rewrite_count_check
    CHECK (rewrite_count BETWEEN 0 AND 3),
  CONSTRAINT baijiahao_automation_runs_similarity_check
    CHECK (source_similarity IS NULL OR source_similarity BETWEEN 0 AND 1),
  CONSTRAINT baijiahao_automation_runs_error_check
    CHECK (last_error_json IS NULL OR jsonb_typeof(last_error_json) = 'object'),
  CONSTRAINT baijiahao_automation_runs_version_check CHECK (version > 0),
  CONSTRAINT baijiahao_automation_runs_finished_check CHECK (
    (
      status IN ('published', 'skipped', 'manual_required', 'publish_failed', 'disabled')
      AND finished_at IS NOT NULL
    ) OR (
      status NOT IN ('published', 'skipped', 'manual_required', 'publish_failed', 'disabled')
      AND finished_at IS NULL
    )
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX baijiahao_automation_runs_source_uq
  ON baijiahao_automation_runs (tenant_id, policy_id, source_content_version_id)
  WHERE source_mode = 'official_site_derived';
--> statement-breakpoint
CREATE INDEX baijiahao_automation_runs_status_idx
  ON baijiahao_automation_runs (tenant_id, status, updated_at, id);
--> statement-breakpoint
CREATE TRIGGER baijiahao_automation_runs_set_updated_at
  BEFORE UPDATE ON baijiahao_automation_runs
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE baijiahao_daily_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  business_date date NOT NULL,
  attempt_no smallint NOT NULL DEFAULT 1,
  status varchar(24) NOT NULL DEFAULT 'running',
  last_error_json jsonb,
  version integer NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL DEFAULT now(),
  scheduled_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT baijiahao_daily_batches_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT baijiahao_daily_batches_policy_date_attempt_uq
    UNIQUE (tenant_id, policy_id, business_date, attempt_no),
  CONSTRAINT baijiahao_daily_batches_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_daily_batches_policy_fk
    FOREIGN KEY (policy_id, tenant_id)
    REFERENCES baijiahao_automation_policies(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_daily_batches_status_check CHECK (
    status IN ('running', 'scheduled', 'completed', 'attention_required', 'cancelled')
  ),
  CONSTRAINT baijiahao_daily_batches_attempt_no_check CHECK (attempt_no > 0),
  CONSTRAINT baijiahao_daily_batches_error_check CHECK (
    last_error_json IS NULL OR jsonb_typeof(last_error_json) = 'object'
  ),
  CONSTRAINT baijiahao_daily_batches_version_check CHECK (version > 0),
  CONSTRAINT baijiahao_daily_batches_terminal_time_check CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX baijiahao_daily_batches_one_active_uq
  ON baijiahao_daily_batches (tenant_id, policy_id, business_date)
  WHERE status IN ('running', 'scheduled');
--> statement-breakpoint
CREATE INDEX baijiahao_daily_batches_status_idx
  ON baijiahao_daily_batches (status, business_date, updated_at, id)
  WHERE status IN ('running', 'scheduled');
--> statement-breakpoint
CREATE TRIGGER baijiahao_daily_batches_set_updated_at
  BEFORE UPDATE ON baijiahao_daily_batches
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE baijiahao_daily_batch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  candidate_no smallint NOT NULL,
  automation_run_id uuid,
  source_content_version_id uuid,
  brief_id uuid,
  package_id uuid,
  variant_id uuid,
  content_version_id uuid,
  publish_job_id uuid,
  status varchar(24) NOT NULL DEFAULT 'pending',
  scheduled_at timestamptz,
  last_error_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  qualified_at timestamptz,
  published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT baijiahao_daily_batch_items_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT baijiahao_daily_batch_items_candidate_uq
    UNIQUE (tenant_id, batch_id, candidate_no),
  CONSTRAINT baijiahao_daily_batch_items_run_uq UNIQUE (tenant_id, automation_run_id),
  CONSTRAINT baijiahao_daily_batch_items_publish_job_uq UNIQUE (tenant_id, publish_job_id),
  CONSTRAINT baijiahao_daily_batch_items_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_daily_batch_items_batch_fk
    FOREIGN KEY (batch_id, tenant_id)
    REFERENCES baijiahao_daily_batches(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_daily_batch_items_run_fk
    FOREIGN KEY (automation_run_id, tenant_id)
    REFERENCES baijiahao_automation_runs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_daily_batch_items_source_version_fk
    FOREIGN KEY (source_content_version_id, tenant_id)
    REFERENCES content_versions(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_daily_batch_items_brief_fk
    FOREIGN KEY (brief_id, tenant_id) REFERENCES briefs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_daily_batch_items_package_fk
    FOREIGN KEY (package_id, tenant_id)
    REFERENCES content_packages(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_daily_batch_items_variant_fk
    FOREIGN KEY (variant_id, tenant_id)
    REFERENCES content_variants(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_daily_batch_items_content_version_fk
    FOREIGN KEY (content_version_id, tenant_id)
    REFERENCES content_versions(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_daily_batch_items_publish_job_fk
    FOREIGN KEY (publish_job_id, tenant_id)
    REFERENCES publish_jobs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_daily_batch_items_candidate_check CHECK (
    candidate_no BETWEEN 1 AND 30
  ),
  CONSTRAINT baijiahao_daily_batch_items_status_check CHECK (
    status IN (
      'pending', 'adapting', 'generating', 'quality_check', 'rewriting',
      'qualified', 'scheduled', 'processing', 'published', 'publish_failed',
      'skipped', 'manual_required', 'reserve', 'retired'
    )
  ),
  CONSTRAINT baijiahao_daily_batch_items_error_check CHECK (
    last_error_json IS NULL OR jsonb_typeof(last_error_json) = 'object'
  )
);
--> statement-breakpoint
CREATE INDEX baijiahao_daily_batch_items_batch_status_idx
  ON baijiahao_daily_batch_items (tenant_id, batch_id, status, candidate_no, id);
--> statement-breakpoint
CREATE TRIGGER baijiahao_daily_batch_items_set_updated_at
  BEFORE UPDATE ON baijiahao_daily_batch_items
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE baijiahao_browser_sessions (
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
  CONSTRAINT baijiahao_browser_sessions_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT baijiahao_browser_sessions_account_uq UNIQUE (tenant_id, account_id),
  CONSTRAINT baijiahao_browser_sessions_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_browser_sessions_account_fk
    FOREIGN KEY (account_id, tenant_id)
    REFERENCES platform_accounts(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_browser_sessions_status_check CHECK (
    status IN (
      'login_required', 'qr_ready', 'authenticated', 'reauth',
      'attention_required', 'disabled'
    )
  ),
  CONSTRAINT baijiahao_browser_sessions_profile_key_check CHECK (
    profile_key ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$'
    AND profile_key !~ '(^|/)\.\.(/|$)'
  ),
  CONSTRAINT baijiahao_browser_sessions_credentials_check CHECK (
    (storage_state_ciphertext IS NULL) = (storage_state_key_version IS NULL)
  ),
  CONSTRAINT baijiahao_browser_sessions_error_check CHECK (
    last_error_json IS NULL OR jsonb_typeof(last_error_json) = 'object'
  ),
  CONSTRAINT baijiahao_browser_sessions_version_check CHECK (version > 0)
);
--> statement-breakpoint
CREATE INDEX baijiahao_browser_sessions_status_idx
  ON baijiahao_browser_sessions (status, updated_at, id);
--> statement-breakpoint
CREATE TRIGGER baijiahao_browser_sessions_set_updated_at
  BEFORE UPDATE ON baijiahao_browser_sessions
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE FUNCTION enforce_baijiahao_browser_session_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM platform_accounts AS account
    WHERE account.id = NEW.account_id
      AND account.tenant_id = NEW.tenant_id
      AND account.platform_code = 'baijiahao'
      AND account.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'browser session account must be a scoped baijiahao account';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER baijiahao_browser_sessions_scope_guard
  BEFORE INSERT OR UPDATE OF tenant_id, account_id
  ON baijiahao_browser_sessions
  FOR EACH ROW
  EXECUTE FUNCTION enforce_baijiahao_browser_session_scope();
--> statement-breakpoint
CREATE TABLE baijiahao_browser_publications (
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
  CONSTRAINT baijiahao_browser_publications_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT baijiahao_browser_publications_job_uq UNIQUE (tenant_id, publish_job_id),
  CONSTRAINT baijiahao_browser_publications_idempotency_uq
    UNIQUE (tenant_id, account_id, idempotency_key),
  CONSTRAINT baijiahao_browser_publications_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_browser_publications_session_fk
    FOREIGN KEY (session_id, tenant_id)
    REFERENCES baijiahao_browser_sessions(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_browser_publications_account_fk
    FOREIGN KEY (account_id, tenant_id)
    REFERENCES platform_accounts(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_browser_publications_publish_job_fk
    FOREIGN KEY (publish_job_id, tenant_id)
    REFERENCES publish_jobs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_browser_publications_content_version_fk
    FOREIGN KEY (content_version_id, tenant_id)
    REFERENCES content_versions(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_browser_publications_hash_check CHECK (
    payload_hash ~ '^[0-9a-f]{64}$' AND content_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT baijiahao_browser_publications_title_check CHECK (
    char_length(btrim(title)) BETWEEN 2 AND 40
  ),
  CONSTRAINT baijiahao_browser_publications_status_check CHECK (
    status IN (
      'prepared', 'submitting', 'unknown', 'processing',
      'published', 'failed', 'manual_required'
    )
  ),
  CONSTRAINT baijiahao_browser_publications_summary_check CHECK (
    jsonb_typeof(field_summary_json) = 'object'
  ),
  CONSTRAINT baijiahao_browser_publications_version_check CHECK (version > 0)
);
--> statement-breakpoint
CREATE INDEX baijiahao_browser_publications_reconcile_idx
  ON baijiahao_browser_publications (status, last_reconciled_at, created_at, id)
  WHERE status IN ('submitting', 'unknown', 'processing');
--> statement-breakpoint
CREATE TRIGGER baijiahao_browser_publications_set_updated_at
  BEFORE UPDATE ON baijiahao_browser_publications
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE baijiahao_browser_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  publication_id uuid NOT NULL,
  kind varchar(32) NOT NULL,
  object_uri text NOT NULL,
  content_hash char(64) NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT baijiahao_browser_artifacts_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT baijiahao_browser_artifacts_object_uq UNIQUE (tenant_id, object_uri),
  CONSTRAINT baijiahao_browser_artifacts_publication_fk
    FOREIGN KEY (publication_id, tenant_id)
    REFERENCES baijiahao_browser_publications(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT baijiahao_browser_artifacts_kind_check CHECK (
    kind IN ('pre_submit', 'post_submit', 'reconcile', 'attention_required')
  ),
  CONSTRAINT baijiahao_browser_artifacts_uri_check CHECK (
    char_length(btrim(object_uri)) BETWEEN 1 AND 2000
  ),
  CONSTRAINT baijiahao_browser_artifacts_hash_check CHECK (
    content_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT baijiahao_browser_artifacts_metadata_check CHECK (
    jsonb_typeof(metadata_json) = 'object'
  )
);
--> statement-breakpoint
CREATE INDEX baijiahao_browser_artifacts_publication_idx
  ON baijiahao_browser_artifacts (tenant_id, publication_id, created_at, id);
