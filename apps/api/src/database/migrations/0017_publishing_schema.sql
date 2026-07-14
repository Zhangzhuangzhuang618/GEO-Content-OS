CREATE TABLE platform_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  platform_code varchar(24) NOT NULL,
  provider_account_id varchar(160),
  display_name varchar(120) NOT NULL,
  credential_ciphertext text,
  credential_key_version varchar(32),
  scopes text[] NOT NULL DEFAULT '{}'::text[],
  token_expires_at timestamptz,
  capabilities_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  publish_mode varchar(16) NOT NULL,
  status varchar(16) NOT NULL,
  timezone varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT platform_accounts_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT platform_accounts_provider_uq
    UNIQUE (tenant_id, platform_code, provider_account_id),
  CONSTRAINT platform_accounts_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT platform_accounts_workspace_fk
    FOREIGN KEY (workspace_id, tenant_id)
    REFERENCES workspaces(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT platform_accounts_platform_check CHECK (
    platform_code IN (
      'official_site', 'baijiahao', 'toutiao', 'zhihu',
      'xiaohongshu', 'wechat_mp', 'douyin'
    )
  ),
  CONSTRAINT platform_accounts_display_name_check
    CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),
  CONSTRAINT platform_accounts_credentials_check CHECK (
    (credential_ciphertext IS NULL) = (credential_key_version IS NULL)
  ),
  CONSTRAINT platform_accounts_scopes_check CHECK (is_valid_nonblank_text_array(scopes)),
  CONSTRAINT platform_accounts_capabilities_check
    CHECK (jsonb_typeof(capabilities_json) = 'object'),
  CONSTRAINT platform_accounts_publish_mode_check
    CHECK (publish_mode IN ('api', 'export', 'manual')),
  CONSTRAINT platform_accounts_status_check CHECK (status IN ('active', 'reauth', 'disabled')),
  CONSTRAINT platform_accounts_timezone_check
    CHECK (char_length(btrim(timezone)) BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE INDEX platform_accounts_workspace_status_idx
  ON platform_accounts (tenant_id, workspace_id, status, platform_code, id)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER platform_accounts_set_updated_at
  BEFORE UPDATE ON platform_accounts
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid,
  asset_type varchar(24) NOT NULL,
  object_uri text NOT NULL,
  content_hash char(64) NOT NULL,
  mime_type varchar(120) NOT NULL,
  size_bytes bigint NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT media_assets_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT media_assets_object_uri_uq UNIQUE (tenant_id, object_uri),
  CONSTRAINT media_assets_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT media_assets_workspace_fk
    FOREIGN KEY (workspace_id, tenant_id)
    REFERENCES workspaces(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT media_assets_project_fk
    FOREIGN KEY (project_id, tenant_id, workspace_id)
    REFERENCES projects(id, tenant_id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT media_assets_created_by_fk
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT media_assets_created_by_membership_fk
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT media_assets_asset_type_check
    CHECK (asset_type IN ('image', 'video', 'audio', 'document', 'screenshot')),
  CONSTRAINT media_assets_object_uri_check CHECK (char_length(btrim(object_uri)) > 0),
  CONSTRAINT media_assets_content_hash_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT media_assets_mime_type_check
    CHECK (char_length(btrim(mime_type)) BETWEEN 1 AND 120),
  CONSTRAINT media_assets_size_check CHECK (size_bytes >= 0),
  CONSTRAINT media_assets_metadata_check CHECK (jsonb_typeof(metadata_json) = 'object')
);
--> statement-breakpoint
CREATE INDEX media_assets_scope_created_idx
  ON media_assets (tenant_id, workspace_id, project_id, created_at DESC, id)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER media_assets_set_updated_at
  BEFORE UPDATE ON media_assets
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE publish_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  account_id uuid NOT NULL,
  scheduled_at timestamptz NOT NULL,
  idempotency_key varchar(160) NOT NULL,
  payload_hash char(64) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'scheduled',
  attempt_count smallint NOT NULL DEFAULT 0,
  external_post_id varchar(200),
  external_url text,
  last_error_json jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT publish_jobs_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT publish_jobs_idempotency_uq UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT publish_jobs_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT publish_jobs_variant_fk
    FOREIGN KEY (variant_id, tenant_id)
    REFERENCES content_variants(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT publish_jobs_content_version_fk
    FOREIGN KEY (content_version_id, tenant_id)
    REFERENCES content_versions(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT publish_jobs_account_fk
    FOREIGN KEY (account_id, tenant_id)
    REFERENCES platform_accounts(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT publish_jobs_created_by_fk
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT publish_jobs_created_by_membership_fk
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT publish_jobs_idempotency_key_check
    CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 160),
  CONSTRAINT publish_jobs_payload_hash_check CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT publish_jobs_status_check CHECK (
    status IN (
      'scheduled', 'publishing', 'published', 'failed', 'cancel_requested', 'cancelled'
    )
  ),
  CONSTRAINT publish_jobs_attempt_count_check CHECK (attempt_count BETWEEN 0 AND 20),
  CONSTRAINT publish_jobs_last_error_check
    CHECK (last_error_json IS NULL OR jsonb_typeof(last_error_json) = 'object')
);
--> statement-breakpoint
CREATE INDEX publish_jobs_due_idx
  ON publish_jobs (status, scheduled_at, created_at, id)
  WHERE status IN ('scheduled', 'cancel_requested');
--> statement-breakpoint
CREATE INDEX publish_jobs_variant_created_idx
  ON publish_jobs (tenant_id, variant_id, created_at DESC, id);
--> statement-breakpoint
CREATE TRIGGER publish_jobs_set_updated_at
  BEFORE UPDATE ON publish_jobs
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE FUNCTION enforce_publish_job_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM content_variants AS variant
    JOIN content_packages AS package
      ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
    JOIN content_versions AS content_version
      ON content_version.id = NEW.content_version_id
      AND content_version.tenant_id = variant.tenant_id
      AND content_version.package_id = variant.package_id
      AND content_version.variant_id = variant.id
    JOIN platform_accounts AS account
      ON account.id = NEW.account_id
      AND account.tenant_id = variant.tenant_id
      AND account.workspace_id = package.workspace_id
      AND account.platform_code = variant.platform_code
    WHERE
      variant.id = NEW.variant_id
      AND variant.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'publish job content version and account must match the variant scope';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER publish_jobs_scope_guard
  BEFORE INSERT OR UPDATE OF tenant_id, variant_id, content_version_id, account_id
  ON publish_jobs
  FOR EACH ROW
  EXECUTE FUNCTION enforce_publish_job_scope();
--> statement-breakpoint
CREATE FUNCTION protect_publish_job_frozen_payload()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'publish job frozen payload cannot be changed';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER publish_jobs_frozen_payload_guard
  BEFORE UPDATE OF tenant_id, variant_id, content_version_id, account_id, idempotency_key, payload_hash
  ON publish_jobs
  FOR EACH ROW
  WHEN (
    OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.variant_id IS DISTINCT FROM NEW.variant_id
    OR OLD.content_version_id IS DISTINCT FROM NEW.content_version_id
    OR OLD.account_id IS DISTINCT FROM NEW.account_id
    OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
    OR OLD.payload_hash IS DISTINCT FROM NEW.payload_hash
  )
  EXECUTE FUNCTION protect_publish_job_frozen_payload();
--> statement-breakpoint
CREATE TABLE publish_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  publish_job_id uuid NOT NULL,
  attempt_no smallint NOT NULL,
  adapter_code varchar(80) NOT NULL,
  status varchar(16) NOT NULL,
  request_hash char(64) NOT NULL,
  response_json jsonb,
  error_code varchar(80),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT publish_attempts_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT publish_attempts_job_attempt_uq
    UNIQUE (tenant_id, publish_job_id, attempt_no),
  CONSTRAINT publish_attempts_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT publish_attempts_job_fk
    FOREIGN KEY (publish_job_id, tenant_id)
    REFERENCES publish_jobs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT publish_attempts_attempt_no_check CHECK (attempt_no BETWEEN 1 AND 20),
  CONSTRAINT publish_attempts_adapter_code_check
    CHECK (char_length(btrim(adapter_code)) BETWEEN 1 AND 80),
  CONSTRAINT publish_attempts_status_check
    CHECK (status IN ('running', 'succeeded', 'failed', 'unknown')),
  CONSTRAINT publish_attempts_request_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT publish_attempts_response_check
    CHECK (response_json IS NULL OR jsonb_typeof(response_json) = 'object'),
  CONSTRAINT publish_attempts_time_check
    CHECK (finished_at IS NULL OR finished_at >= started_at)
);
--> statement-breakpoint
CREATE FUNCTION protect_publish_attempt_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'publish attempts are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER publish_attempts_append_only_guard
  BEFORE UPDATE OR DELETE ON publish_attempts
  FOR EACH ROW
  EXECUTE FUNCTION protect_publish_attempt_history();
--> statement-breakpoint
CREATE TABLE export_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  publish_job_id uuid,
  object_uri text NOT NULL,
  manifest_json jsonb NOT NULL,
  content_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT export_artifacts_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT export_artifacts_object_uri_uq UNIQUE (tenant_id, object_uri),
  CONSTRAINT export_artifacts_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT export_artifacts_variant_fk
    FOREIGN KEY (variant_id, tenant_id)
    REFERENCES content_variants(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT export_artifacts_content_version_fk
    FOREIGN KEY (content_version_id, tenant_id)
    REFERENCES content_versions(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT export_artifacts_publish_job_fk
    FOREIGN KEY (publish_job_id, tenant_id)
    REFERENCES publish_jobs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT export_artifacts_created_by_fk
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT export_artifacts_created_by_membership_fk
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT export_artifacts_object_uri_check CHECK (char_length(btrim(object_uri)) > 0),
  CONSTRAINT export_artifacts_manifest_check CHECK (
    COALESCE(
      jsonb_typeof(manifest_json) = 'object'
      AND manifest_json->>'schema_version' = 'export-manifest@1',
      false
    )
  ),
  CONSTRAINT export_artifacts_content_hash_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT export_artifacts_expiry_check CHECK (expires_at > created_at)
);
--> statement-breakpoint
CREATE INDEX export_artifacts_variant_created_idx
  ON export_artifacts (tenant_id, variant_id, created_at DESC, id);
--> statement-breakpoint
CREATE FUNCTION enforce_export_artifact_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM content_variants AS variant
    JOIN content_versions AS content_version
      ON content_version.id = NEW.content_version_id
      AND content_version.tenant_id = variant.tenant_id
      AND content_version.package_id = variant.package_id
      AND content_version.variant_id = variant.id
    LEFT JOIN publish_jobs AS publish_job
      ON publish_job.id = NEW.publish_job_id
      AND publish_job.tenant_id = variant.tenant_id
      AND publish_job.variant_id = variant.id
      AND publish_job.content_version_id = content_version.id
    WHERE
      variant.id = NEW.variant_id
      AND variant.tenant_id = NEW.tenant_id
      AND (NEW.publish_job_id IS NULL OR publish_job.id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'export artifact version and job must match the variant scope';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER export_artifacts_scope_guard
  BEFORE INSERT ON export_artifacts
  FOR EACH ROW
  EXECUTE FUNCTION enforce_export_artifact_scope();
--> statement-breakpoint
CREATE FUNCTION protect_export_artifact_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'export artifacts are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER export_artifacts_append_only_guard
  BEFORE UPDATE OR DELETE ON export_artifacts
  FOR EACH ROW
  EXECUTE FUNCTION protect_export_artifact_history();
