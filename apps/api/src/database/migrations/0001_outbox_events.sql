CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  event_type varchar(80) NOT NULL,
  aggregate_type varchar(64) NOT NULL,
  aggregate_id uuid NOT NULL,
  payload_json jsonb NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  attempt_count smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by varchar(120),
  last_error text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_events_status_check
    CHECK (status IN ('pending', 'processing', 'published', 'failed')),
  CONSTRAINT outbox_events_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT outbox_events_processing_lease_check CHECK (
    (status = 'processing' AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
    OR (status <> 'processing' AND locked_at IS NULL AND locked_by IS NULL)
  ),
  CONSTRAINT outbox_events_published_at_check CHECK (
    (status = 'published' AND published_at IS NOT NULL)
    OR status <> 'published'
  )
);
--> statement-breakpoint
CREATE INDEX outbox_events_due_idx
  ON outbox_events (next_attempt_at, created_at)
  WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX outbox_events_expired_lease_idx
  ON outbox_events (locked_at, created_at)
  WHERE status = 'processing';
--> statement-breakpoint
CREATE INDEX outbox_events_tenant_created_idx
  ON outbox_events (tenant_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX outbox_events_aggregate_idx
  ON outbox_events (tenant_id, aggregate_type, aggregate_id, created_at DESC);
--> statement-breakpoint
CREATE FUNCTION prevent_outbox_event_payload_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.id,
    NEW.tenant_id,
    NEW.event_type,
    NEW.aggregate_type,
    NEW.aggregate_id,
    NEW.payload_json,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id,
    OLD.tenant_id,
    OLD.event_type,
    OLD.aggregate_type,
    OLD.aggregate_id,
    OLD.payload_json,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'outbox event identity and payload are immutable';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER outbox_events_payload_immutable
  BEFORE UPDATE ON outbox_events
  FOR EACH ROW
  EXECUTE FUNCTION prevent_outbox_event_payload_update();
