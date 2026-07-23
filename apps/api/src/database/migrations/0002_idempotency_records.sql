CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  scope_key varchar(160) NOT NULL,
  idempotency_key varchar(160) NOT NULL,
  request_hash char(64) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'processing',
  response_status smallint,
  response_json jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_records_unique_key
    UNIQUE (tenant_id, scope_key, idempotency_key),
  CONSTRAINT idempotency_records_request_hash_check
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_records_status_check
    CHECK (status IN ('processing', 'completed', 'failed')),
  CONSTRAINT idempotency_records_response_status_check
    CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
  CONSTRAINT idempotency_records_result_check CHECK (
    (status = 'processing' AND response_status IS NULL AND response_json IS NULL)
    OR (status IN ('completed', 'failed') AND response_status IS NOT NULL)
  ),
  CONSTRAINT idempotency_records_expiry_check CHECK (expires_at > created_at)
);
--> statement-breakpoint
CREATE INDEX idempotency_records_expiry_idx
  ON idempotency_records (expires_at);
--> statement-breakpoint
CREATE INDEX idempotency_records_tenant_expiry_idx
  ON idempotency_records (tenant_id, expires_at);
--> statement-breakpoint
CREATE FUNCTION set_row_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER idempotency_records_set_updated_at
  BEFORE UPDATE ON idempotency_records
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();

