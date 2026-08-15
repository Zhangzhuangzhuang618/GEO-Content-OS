ALTER TABLE publish_jobs
  DROP CONSTRAINT publish_jobs_origin_check,
  ADD CONSTRAINT publish_jobs_origin_check CHECK (
    origin IN (
      'manual', 'official_site_automation', 'baijiahao_automation',
      'sohu_automation', 'lieju_automation'
    )
  );
--> statement-breakpoint
ALTER TABLE quality_reports
  DROP CONSTRAINT quality_reports_automation_gate_check,
  ADD CONSTRAINT quality_reports_automation_gate_check CHECK (
    automation_gate_json IS NULL OR COALESCE(
      jsonb_typeof(automation_gate_json) = 'object'
      AND automation_gate_json->>'schema_version' IN (
        'official-site-quality-gate@1', 'baijiahao-quality-gate@1',
        'browser-platform-quality-gate@1'
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
ALTER TABLE content_media_runs
  DROP CONSTRAINT content_media_runs_platform_check,
  ADD CONSTRAINT content_media_runs_platform_check
    CHECK (platform_code IN ('official_site', 'baijiahao', 'sohu', 'lieju'));
--> statement-breakpoint
CREATE TABLE browser_platform_automation_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  account_id uuid NOT NULL,
  platform_code varchar(32) NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  daily_enabled boolean NOT NULL DEFAULT false,
  daily_target_count smallint NOT NULL DEFAULT 1,
  daily_candidate_limit smallint NOT NULL DEFAULT 3,
  daily_generation_time time NOT NULL DEFAULT TIME '00:30',
  daily_timezone varchar(64) NOT NULL DEFAULT 'Asia/Shanghai',
  daily_schedule_times time[] NOT NULL DEFAULT ARRAY[TIME '10:00'],
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
  CONSTRAINT browser_platform_automation_policies_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT browser_platform_automation_policies_account_project_uq
    UNIQUE (tenant_id, account_id, project_id),
  CONSTRAINT browser_platform_automation_policies_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT browser_platform_automation_policies_project_fk
    FOREIGN KEY (project_id, tenant_id, workspace_id)
    REFERENCES projects(id, tenant_id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT browser_platform_automation_policies_account_fk
    FOREIGN KEY (account_id, tenant_id)
    REFERENCES platform_accounts(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT browser_platform_automation_policies_created_by_fk
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT browser_platform_automation_policies_membership_fk
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT browser_platform_automation_policies_platform_check
    CHECK (platform_code IN ('sohu', 'lieju')),
  CONSTRAINT browser_platform_automation_policies_thresholds_check CHECK (
    geo_total_min = 85 AND factual_accuracy_min = 90 AND brand_consistency_min = 90
    AND readability_safety_min = 85 AND question_coverage_min = 80
    AND platform_fit_min = 80
  ),
  CONSTRAINT browser_platform_automation_policies_limits_check
    CHECK (max_rewrites = 3 AND publish_attempt_limit = 3),
  CONSTRAINT browser_platform_automation_policies_daily_check CHECK (
    daily_target_count BETWEEN 1 AND 10
    AND daily_candidate_limit BETWEEN daily_target_count AND 30
    AND cardinality(daily_schedule_times) = daily_target_count
    AND daily_timezone = 'Asia/Shanghai'
    AND (NOT daily_enabled OR enabled)
  ),
  CONSTRAINT browser_platform_automation_policies_version_check CHECK (version > 0)
);
--> statement-breakpoint
CREATE INDEX browser_platform_automation_policies_enabled_idx
  ON browser_platform_automation_policies
    (tenant_id, workspace_id, platform_code, enabled, project_id)
  WHERE enabled;
--> statement-breakpoint
CREATE TRIGGER browser_platform_automation_policies_set_updated_at
  BEFORE UPDATE ON browser_platform_automation_policies
  FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE FUNCTION enforce_browser_platform_automation_policy_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM platform_accounts AS account
    WHERE account.id=NEW.account_id AND account.tenant_id=NEW.tenant_id
      AND account.workspace_id=NEW.workspace_id
      AND account.platform_code=NEW.platform_code
      AND account.deleted_at IS NULL
      AND (NOT NEW.enabled OR (account.status='active' AND account.publish_mode='api'))
  ) THEN
    RAISE EXCEPTION 'browser platform automation account scope is invalid';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER browser_platform_automation_policies_scope_guard
  BEFORE INSERT OR UPDATE OF tenant_id,workspace_id,project_id,account_id,platform_code,enabled
  ON browser_platform_automation_policies
  FOR EACH ROW EXECUTE FUNCTION enforce_browser_platform_automation_policy_scope();
--> statement-breakpoint
CREATE TABLE browser_platform_automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  platform_code varchar(32) NOT NULL,
  variant_id uuid NOT NULL,
  content_version_id uuid,
  status varchar(32) NOT NULL DEFAULT 'generation_pending',
  rewrite_count smallint NOT NULL DEFAULT 0,
  last_quality_report_id uuid,
  publish_job_id uuid,
  last_error_json jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT browser_platform_automation_runs_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT browser_platform_automation_runs_variant_uq UNIQUE (tenant_id, variant_id),
  CONSTRAINT browser_platform_automation_runs_publish_job_uq UNIQUE (tenant_id, publish_job_id),
  CONSTRAINT browser_platform_automation_runs_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT browser_platform_automation_runs_policy_fk
    FOREIGN KEY (policy_id, tenant_id)
    REFERENCES browser_platform_automation_policies(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT browser_platform_automation_runs_variant_fk
    FOREIGN KEY (variant_id, tenant_id)
    REFERENCES content_variants(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT browser_platform_automation_runs_content_version_fk
    FOREIGN KEY (content_version_id, tenant_id)
    REFERENCES content_versions(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT browser_platform_automation_runs_quality_report_fk
    FOREIGN KEY (last_quality_report_id, tenant_id)
    REFERENCES quality_reports(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT browser_platform_automation_runs_publish_job_fk
    FOREIGN KEY (publish_job_id, tenant_id)
    REFERENCES publish_jobs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT browser_platform_automation_runs_platform_check
    CHECK (platform_code IN ('sohu', 'lieju')),
  CONSTRAINT browser_platform_automation_runs_status_check CHECK (
    status IN (
      'generation_pending','generating','quality_pending','rewrite_pending','rewriting',
      'media_pending','scheduled','publishing','processing','published',
      'manual_required','publish_failed','disabled'
    )
  ),
  CONSTRAINT browser_platform_automation_runs_rewrite_count_check
    CHECK (rewrite_count BETWEEN 0 AND 3),
  CONSTRAINT browser_platform_automation_runs_error_check
    CHECK (last_error_json IS NULL OR jsonb_typeof(last_error_json)='object'),
  CONSTRAINT browser_platform_automation_runs_version_check CHECK (version > 0),
  CONSTRAINT browser_platform_automation_runs_finished_check CHECK (
    (status IN ('published','manual_required','publish_failed','disabled') AND finished_at IS NOT NULL)
    OR (status NOT IN ('published','manual_required','publish_failed','disabled') AND finished_at IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX browser_platform_automation_runs_status_idx
  ON browser_platform_automation_runs (tenant_id,platform_code,status,updated_at,id);
--> statement-breakpoint
CREATE TRIGGER browser_platform_automation_runs_set_updated_at
  BEFORE UPDATE ON browser_platform_automation_runs
  FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE FUNCTION enforce_browser_platform_automation_run_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM browser_platform_automation_policies AS policy
    JOIN content_variants AS variant
      ON variant.id=NEW.variant_id AND variant.tenant_id=NEW.tenant_id
    WHERE policy.id=NEW.policy_id AND policy.tenant_id=NEW.tenant_id
      AND policy.platform_code=NEW.platform_code
      AND variant.platform_code=NEW.platform_code
      AND variant.platform_account_id=policy.account_id
  ) THEN
    RAISE EXCEPTION 'browser platform automation run scope is invalid';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER browser_platform_automation_runs_scope_guard
  BEFORE INSERT OR UPDATE OF tenant_id,policy_id,platform_code,variant_id
  ON browser_platform_automation_runs
  FOR EACH ROW EXECUTE FUNCTION enforce_browser_platform_automation_run_scope();
--> statement-breakpoint
CREATE TABLE browser_platform_daily_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  business_date date NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'running',
  last_error_json jsonb,
  version integer NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL DEFAULT now(),
  scheduled_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT browser_platform_daily_batches_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT browser_platform_daily_batches_policy_date_uq
    UNIQUE (tenant_id, policy_id, business_date),
  CONSTRAINT browser_platform_daily_batches_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT browser_platform_daily_batches_policy_fk
    FOREIGN KEY (policy_id, tenant_id)
    REFERENCES browser_platform_automation_policies(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT browser_platform_daily_batches_status_check
    CHECK (status IN ('running','scheduled','completed','attention_required','cancelled')),
  CONSTRAINT browser_platform_daily_batches_error_check
    CHECK (last_error_json IS NULL OR jsonb_typeof(last_error_json)='object'),
  CONSTRAINT browser_platform_daily_batches_version_check CHECK (version > 0),
  CONSTRAINT browser_platform_daily_batches_terminal_time_check CHECK (
    (status='completed' AND completed_at IS NOT NULL)
    OR (status<>'completed' AND completed_at IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX browser_platform_daily_batches_status_idx
  ON browser_platform_daily_batches (status,business_date,updated_at,id)
  WHERE status IN ('running','scheduled');
--> statement-breakpoint
CREATE TRIGGER browser_platform_daily_batches_set_updated_at
  BEFORE UPDATE ON browser_platform_daily_batches
  FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE browser_platform_daily_batch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  candidate_no smallint NOT NULL,
  automation_run_id uuid NOT NULL,
  brief_id uuid NOT NULL,
  package_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  content_version_id uuid,
  publish_job_id uuid,
  status varchar(24) NOT NULL DEFAULT 'generating',
  scheduled_at timestamptz,
  last_error_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  qualified_at timestamptz,
  published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT browser_platform_daily_batch_items_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT browser_platform_daily_batch_items_candidate_uq
    UNIQUE (tenant_id,batch_id,candidate_no),
  CONSTRAINT browser_platform_daily_batch_items_run_uq UNIQUE (tenant_id,automation_run_id),
  CONSTRAINT browser_platform_daily_batch_items_publish_job_uq UNIQUE (tenant_id,publish_job_id),
  CONSTRAINT browser_platform_daily_batch_items_batch_fk
    FOREIGN KEY (batch_id,tenant_id)
    REFERENCES browser_platform_daily_batches(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT browser_platform_daily_batch_items_run_fk
    FOREIGN KEY (automation_run_id,tenant_id)
    REFERENCES browser_platform_automation_runs(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT browser_platform_daily_batch_items_brief_fk
    FOREIGN KEY (brief_id,tenant_id) REFERENCES briefs(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT browser_platform_daily_batch_items_package_fk
    FOREIGN KEY (package_id,tenant_id) REFERENCES content_packages(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT browser_platform_daily_batch_items_variant_fk
    FOREIGN KEY (variant_id,tenant_id) REFERENCES content_variants(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT browser_platform_daily_batch_items_content_version_fk
    FOREIGN KEY (content_version_id,tenant_id)
    REFERENCES content_versions(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT browser_platform_daily_batch_items_publish_job_fk
    FOREIGN KEY (publish_job_id,tenant_id) REFERENCES publish_jobs(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT browser_platform_daily_batch_items_candidate_check
    CHECK (candidate_no BETWEEN 1 AND 30),
  CONSTRAINT browser_platform_daily_batch_items_status_check CHECK (
    status IN (
      'generating','quality_check','rewriting','media_pending','scheduled','processing',
      'published','publish_failed','manual_required','retired'
    )
  ),
  CONSTRAINT browser_platform_daily_batch_items_error_check
    CHECK (last_error_json IS NULL OR jsonb_typeof(last_error_json)='object')
);
--> statement-breakpoint
CREATE INDEX browser_platform_daily_batch_items_batch_status_idx
  ON browser_platform_daily_batch_items (tenant_id,batch_id,status,candidate_no,id);
--> statement-breakpoint
CREATE TRIGGER browser_platform_daily_batch_items_set_updated_at
  BEFORE UPDATE ON browser_platform_daily_batch_items
  FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();
