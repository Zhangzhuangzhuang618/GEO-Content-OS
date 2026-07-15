ALTER TABLE platform_accounts
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT platform_accounts_version_check CHECK (version > 0);
--> statement-breakpoint
CREATE INDEX platform_accounts_tenant_version_idx
  ON platform_accounts (tenant_id, id, version)
  WHERE deleted_at IS NULL;
