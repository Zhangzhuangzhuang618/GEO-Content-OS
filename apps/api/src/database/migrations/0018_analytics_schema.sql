CREATE TABLE import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  source varchar(16) NOT NULL,
  file_uri text,
  content_hash char(64),
  status varchar(16) NOT NULL,
  row_count integer,
  error_json jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_jobs_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT import_jobs_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT import_jobs_workspace_fk
    FOREIGN KEY (workspace_id, tenant_id)
    REFERENCES workspaces(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT import_jobs_created_by_fk
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT import_jobs_created_by_membership_fk
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT import_jobs_source_check CHECK (source IN ('api', 'csv', 'manual')),
  CONSTRAINT import_jobs_file_uri_check
    CHECK (file_uri IS NULL OR char_length(btrim(file_uri)) > 0),
  CONSTRAINT import_jobs_content_hash_check
    CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT import_jobs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'rolled_back')),
  CONSTRAINT import_jobs_row_count_check CHECK (row_count IS NULL OR row_count >= 0),
  CONSTRAINT import_jobs_error_check
    CHECK (error_json IS NULL OR jsonb_typeof(error_json) = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX import_jobs_workspace_content_hash_uq
  ON import_jobs (tenant_id, workspace_id, content_hash)
  WHERE content_hash IS NOT NULL;
--> statement-breakpoint
CREATE INDEX import_jobs_workspace_status_idx
  ON import_jobs (tenant_id, workspace_id, status, created_at DESC, id);
--> statement-breakpoint
CREATE TRIGGER import_jobs_set_updated_at
  BEFORE UPDATE ON import_jobs
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE metric_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  import_job_id uuid,
  platform_code varchar(24) NOT NULL,
  account_id uuid,
  variant_id uuid,
  metric_date date NOT NULL,
  metric_name varchar(64) NOT NULL,
  metric_value numeric(18,4) NOT NULL,
  source varchar(16) NOT NULL,
  dimension_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT metric_records_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT metric_records_dimension_uq UNIQUE (tenant_id, dimension_hash),
  CONSTRAINT metric_records_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT metric_records_workspace_fk
    FOREIGN KEY (workspace_id, tenant_id)
    REFERENCES workspaces(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT metric_records_import_job_fk
    FOREIGN KEY (import_job_id, tenant_id)
    REFERENCES import_jobs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT metric_records_account_fk
    FOREIGN KEY (account_id, tenant_id)
    REFERENCES platform_accounts(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT metric_records_variant_fk
    FOREIGN KEY (variant_id, tenant_id)
    REFERENCES content_variants(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT metric_records_platform_check CHECK (
    platform_code IN (
      'official_site', 'baijiahao', 'toutiao', 'zhihu',
      'xiaohongshu', 'wechat_mp', 'douyin'
    )
  ),
  CONSTRAINT metric_records_metric_name_check
    CHECK (metric_name ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT metric_records_source_check CHECK (source IN ('api', 'csv', 'manual')),
  CONSTRAINT metric_records_dimension_hash_check CHECK (dimension_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX metric_records_workspace_date_idx
  ON metric_records (
    tenant_id, workspace_id, metric_date DESC, platform_code, metric_name, id
  );
--> statement-breakpoint
CREATE INDEX metric_records_variant_date_idx
  ON metric_records (tenant_id, variant_id, metric_date DESC, metric_name, id)
  WHERE variant_id IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION enforce_metric_record_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.import_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM import_jobs AS import_job
    WHERE import_job.id = NEW.import_job_id
      AND import_job.tenant_id = NEW.tenant_id
      AND import_job.workspace_id = NEW.workspace_id
      AND import_job.source = NEW.source
  ) THEN
    RAISE EXCEPTION 'metric record import job must match its workspace and source';
  END IF;

  IF NEW.account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM platform_accounts AS account
    WHERE account.id = NEW.account_id
      AND account.tenant_id = NEW.tenant_id
      AND account.workspace_id = NEW.workspace_id
      AND account.platform_code = NEW.platform_code
  ) THEN
    RAISE EXCEPTION 'metric record account must match its workspace and platform';
  END IF;

  IF NEW.variant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM content_variants AS variant
    JOIN content_packages AS package
      ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
    WHERE variant.id = NEW.variant_id
      AND variant.tenant_id = NEW.tenant_id
      AND package.workspace_id = NEW.workspace_id
      AND variant.platform_code = NEW.platform_code
  ) THEN
    RAISE EXCEPTION 'metric record variant must match its workspace and platform';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER metric_records_scope_guard
  BEFORE INSERT ON metric_records
  FOR EACH ROW
  EXECUTE FUNCTION enforce_metric_record_scope();
--> statement-breakpoint
CREATE FUNCTION protect_metric_record_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'metric records are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER metric_records_append_only_guard
  BEFORE UPDATE OR DELETE ON metric_records
  FOR EACH ROW
  EXECUTE FUNCTION protect_metric_record_history();
--> statement-breakpoint
CREATE TABLE visibility_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  platform_code varchar(24) NOT NULL,
  query_text text NOT NULL,
  query_hash char(64) NOT NULL,
  observed_at timestamptz NOT NULL,
  rank_position integer,
  is_cited boolean NOT NULL,
  evidence_asset_id uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visibility_observations_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT visibility_observations_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT visibility_observations_workspace_fk
    FOREIGN KEY (workspace_id, tenant_id)
    REFERENCES workspaces(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT visibility_observations_evidence_fk
    FOREIGN KEY (evidence_asset_id, tenant_id)
    REFERENCES media_assets(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT visibility_observations_platform_check CHECK (
    platform_code IN (
      'official_site', 'baijiahao', 'toutiao', 'zhihu',
      'xiaohongshu', 'wechat_mp', 'douyin'
    )
  ),
  CONSTRAINT visibility_observations_query_check CHECK (char_length(btrim(query_text)) > 0),
  CONSTRAINT visibility_observations_query_hash_check CHECK (query_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT visibility_observations_rank_check
    CHECK (rank_position IS NULL OR rank_position > 0),
  CONSTRAINT visibility_observations_notes_check
    CHECK (notes IS NULL OR char_length(btrim(notes)) > 0)
);
--> statement-breakpoint
CREATE INDEX visibility_observations_query_time_idx
  ON visibility_observations (
    tenant_id, workspace_id, query_hash, platform_code, observed_at DESC, id
  );
--> statement-breakpoint
CREATE FUNCTION enforce_visibility_evidence_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.evidence_asset_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM media_assets AS asset
    WHERE asset.id = NEW.evidence_asset_id
      AND asset.tenant_id = NEW.tenant_id
      AND asset.workspace_id = NEW.workspace_id
      AND asset.asset_type = 'screenshot'
      AND asset.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'visibility evidence must be an active screenshot in the same workspace';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER visibility_observations_evidence_guard
  BEFORE INSERT ON visibility_observations
  FOR EACH ROW
  EXECUTE FUNCTION enforce_visibility_evidence_scope();
--> statement-breakpoint
CREATE FUNCTION protect_visibility_observation_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'visibility observations are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER visibility_observations_append_only_guard
  BEFORE UPDATE OR DELETE ON visibility_observations
  FOR EACH ROW
  EXECUTE FUNCTION protect_visibility_observation_history();
--> statement-breakpoint
CREATE INDEX usage_ledger_package_time_idx
  ON usage_ledger (tenant_id, package_id, created_at DESC, id)
  WHERE package_id IS NOT NULL;
