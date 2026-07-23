ALTER TABLE workspaces
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT workspaces_version_check CHECK (version > 0);
--> statement-breakpoint
CREATE INDEX workspaces_tenant_version_idx
  ON workspaces (tenant_id, id, version)
  WHERE deleted_at IS NULL;
