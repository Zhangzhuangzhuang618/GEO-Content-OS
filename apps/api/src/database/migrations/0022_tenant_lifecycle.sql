CREATE TABLE tenant_export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'queued',
  object_uri text,
  manifest_hash char(64),
  expires_at timestamptz,
  error_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_export_jobs_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT tenant_export_jobs_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT tenant_export_jobs_requested_by_fk
    FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT tenant_export_jobs_requested_by_membership_fk
    FOREIGN KEY (tenant_id, requested_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT tenant_export_jobs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'expired')),
  CONSTRAINT tenant_export_jobs_object_uri_check
    CHECK (object_uri IS NULL OR char_length(btrim(object_uri)) > 0),
  CONSTRAINT tenant_export_jobs_manifest_hash_check
    CHECK (manifest_hash IS NULL OR manifest_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tenant_export_jobs_error_check
    CHECK (error_json IS NULL OR jsonb_typeof(error_json) = 'object'),
  CONSTRAINT tenant_export_jobs_result_check CHECK (
    (status = 'succeeded' AND object_uri IS NOT NULL AND manifest_hash IS NOT NULL AND expires_at IS NOT NULL)
    OR status <> 'succeeded'
  )
);
--> statement-breakpoint
CREATE INDEX tenant_export_jobs_tenant_created_idx
  ON tenant_export_jobs (tenant_id, created_at DESC, id);
--> statement-breakpoint
CREATE INDEX tenant_export_jobs_due_idx
  ON tenant_export_jobs (status, expires_at, id)
  WHERE status IN ('succeeded', 'running');
--> statement-breakpoint
CREATE TRIGGER tenant_export_jobs_set_updated_at
  BEFORE UPDATE ON tenant_export_jobs
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
