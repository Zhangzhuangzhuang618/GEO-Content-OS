ALTER TABLE invitations
  ADD CONSTRAINT invitations_terminal_state_check
  CHECK (accepted_at IS NULL OR revoked_at IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX invitations_tenant_email_pending_uq
  ON invitations (tenant_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
--> statement-breakpoint
CREATE FUNCTION protect_invitation_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invitation history is append-only';
  END IF;

  IF ROW(
    NEW.id,
    NEW.tenant_id,
    NEW.email,
    NEW.role_code,
    NEW.workspace_scope_json,
    NEW.token_hash,
    NEW.expires_at,
    NEW.invited_by,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id,
    OLD.tenant_id,
    OLD.email,
    OLD.role_code,
    OLD.workspace_scope_json,
    OLD.token_hash,
    OLD.expires_at,
    OLD.invited_by,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'invitation identity and scope are immutable';
  END IF;

  IF OLD.accepted_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'terminal invitation cannot change';
  END IF;

  IF (NEW.accepted_at IS NULL) = (NEW.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'invitation must transition to exactly one terminal state';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER invitations_history_update_guard
  BEFORE UPDATE ON invitations
  FOR EACH ROW
  EXECUTE FUNCTION protect_invitation_history();
--> statement-breakpoint
CREATE TRIGGER invitations_history_delete_guard
  BEFORE DELETE ON invitations
  FOR EACH ROW
  EXECUTE FUNCTION protect_invitation_history();
