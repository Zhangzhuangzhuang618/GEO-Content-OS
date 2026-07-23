ALTER TABLE publish_jobs
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT publish_jobs_version_check CHECK (version > 0);
--> statement-breakpoint
CREATE INDEX publish_jobs_tenant_version_idx
  ON publish_jobs (tenant_id, id, version);
