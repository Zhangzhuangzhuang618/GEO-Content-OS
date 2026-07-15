CREATE TABLE analytics_export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid,
  requested_by uuid NOT NULL,
  query_hash char(64) NOT NULL,
  query_json jsonb NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'queued',
  object_uri text,
  content_hash char(64),
  row_count integer,
  error_json jsonb,
  expires_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analytics_export_jobs_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT analytics_export_jobs_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT analytics_export_jobs_workspace_fk
    FOREIGN KEY (workspace_id, tenant_id)
    REFERENCES workspaces(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT analytics_export_jobs_requested_by_fk
    FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT analytics_export_jobs_requested_by_membership_fk
    FOREIGN KEY (tenant_id, requested_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT analytics_export_jobs_query_hash_check
    CHECK (query_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT analytics_export_jobs_query_json_check CHECK (
    jsonb_typeof(query_json) = 'object'
    AND query_json ->> 'schema_version' = 'analytics-export-query@1'
  ),
  CONSTRAINT analytics_export_jobs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'expired')),
  CONSTRAINT analytics_export_jobs_object_uri_check
    CHECK (object_uri IS NULL OR char_length(btrim(object_uri)) > 0),
  CONSTRAINT analytics_export_jobs_content_hash_check
    CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT analytics_export_jobs_row_count_check
    CHECK (row_count IS NULL OR row_count >= 0),
  CONSTRAINT analytics_export_jobs_error_check CHECK (
    error_json IS NULL OR (
      jsonb_typeof(error_json) = 'object'
      AND error_json ->> 'schema_version' = 'analytics-export-error@1'
    )
  ),
  CONSTRAINT analytics_export_jobs_expiry_check
    CHECK (expires_at IS NULL OR expires_at > created_at),
  CONSTRAINT analytics_export_jobs_version_check CHECK (version > 0),
  CONSTRAINT analytics_export_jobs_result_check CHECK (
    (status = 'succeeded' AND object_uri IS NOT NULL AND content_hash IS NOT NULL
      AND row_count IS NOT NULL AND expires_at IS NOT NULL)
    OR status <> 'succeeded'
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX analytics_export_jobs_active_query_uq
  ON analytics_export_jobs (tenant_id, query_hash)
  WHERE status IN ('queued', 'running');
--> statement-breakpoint
CREATE UNIQUE INDEX analytics_export_jobs_object_uri_uq
  ON analytics_export_jobs (tenant_id, object_uri)
  WHERE object_uri IS NOT NULL;
--> statement-breakpoint
CREATE INDEX analytics_export_jobs_workspace_created_idx
  ON analytics_export_jobs (tenant_id, workspace_id, created_at DESC, id);
--> statement-breakpoint
CREATE INDEX analytics_export_jobs_status_idx
  ON analytics_export_jobs (status, created_at, id)
  WHERE status IN ('queued', 'running');
--> statement-breakpoint
CREATE TRIGGER analytics_export_jobs_set_updated_at
  BEFORE UPDATE ON analytics_export_jobs
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
