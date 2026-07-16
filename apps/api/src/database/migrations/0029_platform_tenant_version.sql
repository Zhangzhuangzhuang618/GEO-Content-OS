ALTER TABLE tenants
  ADD COLUMN version integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE tenants
  ADD CONSTRAINT tenants_version_check CHECK (version > 0);
--> statement-breakpoint
CREATE INDEX tenants_version_idx
  ON tenants (id, version)
  WHERE deleted_at IS NULL;
