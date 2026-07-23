CREATE TABLE official_site_automation_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  account_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
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
  CONSTRAINT official_site_automation_policies_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT official_site_automation_policies_project_uq UNIQUE (tenant_id, project_id),
  CONSTRAINT official_site_automation_policies_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT official_site_automation_policies_project_fk
    FOREIGN KEY (project_id, tenant_id, workspace_id)
    REFERENCES projects(id, tenant_id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT official_site_automation_policies_account_fk
    FOREIGN KEY (account_id, tenant_id)
    REFERENCES platform_accounts(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT official_site_automation_policies_created_by_fk
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT official_site_automation_policies_membership_fk
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT official_site_automation_policies_thresholds_check CHECK (
    geo_total_min = 85
    AND factual_accuracy_min = 90
    AND brand_consistency_min = 90
    AND readability_safety_min = 85
    AND question_coverage_min = 80
    AND platform_fit_min = 80
  ),
  CONSTRAINT official_site_automation_policies_limits_check CHECK (
    max_rewrites = 3 AND publish_attempt_limit = 3
  ),
  CONSTRAINT official_site_automation_policies_version_check CHECK (version > 0)
);
--> statement-breakpoint
CREATE INDEX official_site_automation_policies_enabled_idx
  ON official_site_automation_policies (tenant_id, workspace_id, enabled, project_id)
  WHERE enabled;
--> statement-breakpoint
CREATE TRIGGER official_site_automation_policies_set_updated_at
  BEFORE UPDATE ON official_site_automation_policies
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE FUNCTION enforce_official_site_automation_policy_scope()
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
      AND account.platform_code = 'official_site'
      AND account.deleted_at IS NULL
      AND (
        NOT NEW.enabled
        OR (account.status = 'active' AND account.publish_mode = 'api')
      )
  ) THEN
    RAISE EXCEPTION 'official site automation account must be an active-scope official_site account';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER official_site_automation_policies_scope_guard
  BEFORE INSERT OR UPDATE OF tenant_id, workspace_id, project_id, account_id, enabled
  ON official_site_automation_policies
  FOR EACH ROW
  EXECUTE FUNCTION enforce_official_site_automation_policy_scope();
--> statement-breakpoint
CREATE TABLE official_site_automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'quality_pending',
  rewrite_count smallint NOT NULL DEFAULT 0,
  last_quality_report_id uuid,
  publish_job_id uuid,
  last_error_json jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT official_site_automation_runs_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT official_site_automation_runs_variant_uq UNIQUE (tenant_id, variant_id),
  CONSTRAINT official_site_automation_runs_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT official_site_automation_runs_policy_fk
    FOREIGN KEY (policy_id, tenant_id)
    REFERENCES official_site_automation_policies(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT official_site_automation_runs_variant_fk
    FOREIGN KEY (variant_id, tenant_id)
    REFERENCES content_variants(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT official_site_automation_runs_content_version_fk
    FOREIGN KEY (content_version_id, tenant_id)
    REFERENCES content_versions(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT official_site_automation_runs_quality_report_fk
    FOREIGN KEY (last_quality_report_id, tenant_id)
    REFERENCES quality_reports(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT official_site_automation_runs_publish_job_fk
    FOREIGN KEY (publish_job_id, tenant_id)
    REFERENCES publish_jobs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT official_site_automation_runs_status_check CHECK (
    status IN (
      'quality_pending', 'rewrite_pending', 'rewriting', 'publish_pending',
      'publishing', 'published', 'manual_required', 'publish_failed', 'disabled'
    )
  ),
  CONSTRAINT official_site_automation_runs_rewrite_count_check
    CHECK (rewrite_count BETWEEN 0 AND 3),
  CONSTRAINT official_site_automation_runs_error_check
    CHECK (last_error_json IS NULL OR jsonb_typeof(last_error_json) = 'object'),
  CONSTRAINT official_site_automation_runs_version_check CHECK (version > 0),
  CONSTRAINT official_site_automation_runs_finished_check CHECK (
    (status IN ('published', 'manual_required', 'publish_failed', 'disabled') AND finished_at IS NOT NULL)
    OR (status NOT IN ('published', 'manual_required', 'publish_failed', 'disabled') AND finished_at IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX official_site_automation_runs_status_idx
  ON official_site_automation_runs (tenant_id, status, updated_at, id);
--> statement-breakpoint
CREATE TRIGGER official_site_automation_runs_set_updated_at
  BEFORE UPDATE ON official_site_automation_runs
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
ALTER TABLE quality_reports
  ADD COLUMN automation_gate_json jsonb;
--> statement-breakpoint
ALTER TABLE quality_reports
  ADD CONSTRAINT quality_reports_automation_gate_check CHECK (
    automation_gate_json IS NULL OR COALESCE(
      jsonb_typeof(automation_gate_json) = 'object'
      AND automation_gate_json->>'schema_version' = 'official-site-quality-gate@1'
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
ALTER TABLE publish_jobs
  ADD COLUMN origin varchar(32) NOT NULL DEFAULT 'manual',
  ADD COLUMN published_at timestamptz,
  ADD CONSTRAINT publish_jobs_origin_check
    CHECK (origin IN ('manual', 'official_site_automation'));
--> statement-breakpoint
CREATE FUNCTION protect_publish_job_origin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'publish job origin is immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER publish_jobs_origin_guard
  BEFORE UPDATE OF origin ON publish_jobs
  FOR EACH ROW
  WHEN (OLD.origin IS DISTINCT FROM NEW.origin)
  EXECUTE FUNCTION protect_publish_job_origin();
