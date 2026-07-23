ALTER TABLE idempotency_records
  DROP CONSTRAINT idempotency_records_unique_key,
  ALTER COLUMN tenant_id DROP NOT NULL,
  ADD CONSTRAINT idempotency_records_unique_key
    UNIQUE NULLS NOT DISTINCT (tenant_id, scope_key, idempotency_key);
--> statement-breakpoint
ALTER TABLE audit_events
  ALTER COLUMN tenant_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE prompt_versions
  ADD COLUMN change_summary varchar(500) NOT NULL DEFAULT 'Imported legacy version',
  ADD COLUMN published_by uuid,
  ADD COLUMN lock_version integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT prompt_versions_published_by_fk
    FOREIGN KEY (published_by) REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT prompt_versions_change_summary_check
    CHECK (char_length(btrim(change_summary)) BETWEEN 1 AND 500),
  ADD CONSTRAINT prompt_versions_lock_version_check CHECK (lock_version > 0);
--> statement-breakpoint
UPDATE prompt_versions
SET published_by = created_by
WHERE status IN ('published', 'retired') AND published_by IS NULL;
--> statement-breakpoint
CREATE INDEX prompt_versions_status_created_idx
  ON prompt_versions (status, created_at DESC, id DESC);
--> statement-breakpoint
ALTER TABLE platform_rule_versions
  ADD COLUMN change_summary varchar(500) NOT NULL DEFAULT 'Imported legacy version',
  ADD COLUMN published_by uuid,
  ADD COLUMN lock_version integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT platform_rule_versions_published_by_fk
    FOREIGN KEY (published_by) REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT platform_rule_versions_change_summary_check
    CHECK (char_length(btrim(change_summary)) BETWEEN 1 AND 500),
  ADD CONSTRAINT platform_rule_versions_lock_version_check CHECK (lock_version > 0);
--> statement-breakpoint
UPDATE platform_rule_versions
SET published_by = created_by
WHERE status IN ('published', 'retired') AND published_by IS NULL;
--> statement-breakpoint
CREATE INDEX platform_rule_versions_status_created_idx
  ON platform_rule_versions (status, created_at DESC, id DESC);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_prompt_version_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'prompt versions cannot be deleted';
  END IF;
  IF ROW(
    NEW.skill_name, NEW.version, NEW.schema_version, NEW.system_prompt,
    NEW.task_template, NEW.content_hash, NEW.change_summary,
    NEW.created_by, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.skill_name, OLD.version, OLD.schema_version, OLD.system_prompt,
    OLD.task_template, OLD.content_hash, OLD.change_summary,
    OLD.created_by, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'prompt version content is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_platform_rule_version_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'platform rule versions cannot be deleted';
  END IF;
  IF ROW(
    NEW.platform_code, NEW.version, NEW.rules_json, NEW.content_hash,
    NEW.change_summary, NEW.created_by, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.platform_code, OLD.version, OLD.rules_json, OLD.content_hash,
    OLD.change_summary, OLD.created_by, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'platform rule version content is immutable';
  END IF;
  RETURN NEW;
END;
$$;
