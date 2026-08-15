CREATE TABLE lieju_api_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  publish_job_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  payload_hash char(64) NOT NULL,
  attempt_no smallint NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'reserved',
  remote_reference varchar(240),
  external_url text,
  response_hash char(64),
  submitted_at timestamptz,
  last_error_json jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lieju_api_publications_id_tenant_uq UNIQUE (id,tenant_id),
  CONSTRAINT lieju_api_publications_job_uq UNIQUE (tenant_id,publish_job_id),
  CONSTRAINT lieju_api_publications_idempotency_uq
    UNIQUE (tenant_id,account_id,idempotency_key),
  CONSTRAINT lieju_api_publications_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT lieju_api_publications_account_fk
    FOREIGN KEY (account_id,tenant_id)
    REFERENCES platform_accounts(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT lieju_api_publications_job_fk
    FOREIGN KEY (publish_job_id,tenant_id)
    REFERENCES publish_jobs(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT lieju_api_publications_content_version_fk
    FOREIGN KEY (content_version_id,tenant_id)
    REFERENCES content_versions(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT lieju_api_publications_hash_check CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT lieju_api_publications_response_hash_check
    CHECK (response_hash IS NULL OR response_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT lieju_api_publications_attempt_check CHECK (attempt_no BETWEEN 1 AND 20),
  CONSTRAINT lieju_api_publications_status_check CHECK (
    status IN ('reserved','processing','published','rejected','manual_required','not_published')
  ),
  CONSTRAINT lieju_api_publications_url_check CHECK (
    external_url IS NULL OR external_url ~ '^https://([a-z0-9-]+[.])*lieju[.]com/'
  ),
  CONSTRAINT lieju_api_publications_error_check
    CHECK (last_error_json IS NULL OR jsonb_typeof(last_error_json)='object'),
  CONSTRAINT lieju_api_publications_version_check CHECK (version > 0)
);
--> statement-breakpoint
CREATE INDEX lieju_api_publications_status_idx
  ON lieju_api_publications (tenant_id,status,updated_at,id);
--> statement-breakpoint
CREATE TRIGGER lieju_api_publications_set_updated_at
  BEFORE UPDATE ON lieju_api_publications
  FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE FUNCTION enforce_lieju_api_publication_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM publish_jobs AS job
    JOIN platform_accounts AS account
      ON account.id=job.account_id AND account.tenant_id=job.tenant_id
    JOIN content_variants AS variant
      ON variant.id=job.variant_id AND variant.tenant_id=job.tenant_id
    WHERE job.id=NEW.publish_job_id AND job.tenant_id=NEW.tenant_id
      AND job.account_id=NEW.account_id
      AND job.content_version_id=NEW.content_version_id
      AND job.idempotency_key=NEW.idempotency_key
      AND job.payload_hash=NEW.payload_hash
      AND account.platform_code='lieju'
      AND account.publish_mode='api'
      AND variant.platform_code='lieju'
  ) THEN
    RAISE EXCEPTION 'lieju official api publication scope is invalid';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lieju_api_publications_scope_guard
  BEFORE INSERT OR UPDATE OF
    tenant_id,account_id,publish_job_id,content_version_id,idempotency_key,payload_hash
  ON lieju_api_publications
  FOR EACH ROW EXECUTE FUNCTION enforce_lieju_api_publication_scope();
