ALTER TABLE memberships
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT memberships_version_check CHECK (version > 0);
--> statement-breakpoint
CREATE INDEX memberships_tenant_version_idx
  ON memberships (tenant_id, id, version);
--> statement-breakpoint
CREATE FUNCTION protect_last_active_tenant_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  departing_owner boolean := false;
BEGIN
  IF OLD.status = 'active' AND OLD.role_code = 'tenant_owner' THEN
    departing_owner := NEW.status <> 'active' OR NEW.role_code <> 'tenant_owner';
  END IF;

  IF departing_owner THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('membership-owner:' || OLD.tenant_id::text, 0)
    );
    IF NOT EXISTS (
      SELECT 1
      FROM memberships AS membership
      WHERE membership.tenant_id = OLD.tenant_id
        AND membership.id <> OLD.id
        AND membership.status = 'active'
        AND membership.role_code = 'tenant_owner'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'memberships_last_active_owner_check',
        MESSAGE = 'last active tenant_owner cannot be disabled, demoted, or deleted';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER memberships_last_active_owner_guard
  BEFORE UPDATE OF status, role_code ON memberships
  FOR EACH ROW
  EXECUTE FUNCTION protect_last_active_tenant_owner();
