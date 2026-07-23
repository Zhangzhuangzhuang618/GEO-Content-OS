CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT password_reset_tokens_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT password_reset_tokens_token_hash_uq UNIQUE (token_hash),
  CONSTRAINT password_reset_tokens_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT password_reset_tokens_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT password_reset_tokens_used_at_check CHECK (used_at IS NULL OR used_at >= created_at)
);
--> statement-breakpoint
CREATE INDEX password_reset_tokens_user_pending_idx
  ON password_reset_tokens (user_id, expires_at DESC)
  WHERE used_at IS NULL;
--> statement-breakpoint
CREATE INDEX password_reset_tokens_expiry_idx
  ON password_reset_tokens (expires_at)
  WHERE used_at IS NULL;
--> statement-breakpoint
CREATE FUNCTION protect_password_reset_token_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'password reset token history is append-only';
  END IF;

  IF ROW(NEW.id, NEW.user_id, NEW.token_hash, NEW.expires_at, NEW.created_at)
      IS DISTINCT FROM
     ROW(OLD.id, OLD.user_id, OLD.token_hash, OLD.expires_at, OLD.created_at)
  THEN
    RAISE EXCEPTION 'password reset token identity is immutable';
  END IF;

  IF OLD.used_at IS NOT NULL OR NEW.used_at IS NULL THEN
    RAISE EXCEPTION 'password reset token can only transition from unused to used';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER password_reset_tokens_history_update_guard
  BEFORE UPDATE ON password_reset_tokens
  FOR EACH ROW
  EXECUTE FUNCTION protect_password_reset_token_history();
--> statement-breakpoint
CREATE TRIGGER password_reset_tokens_history_delete_guard
  BEFORE DELETE ON password_reset_tokens
  FOR EACH ROW
  EXECUTE FUNCTION protect_password_reset_token_history();
