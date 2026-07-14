ALTER TABLE generation_runs
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT generation_runs_version_check CHECK (version > 0);
--> statement-breakpoint
CREATE FUNCTION is_valid_uuid_jsonb_array(
  input_value jsonb,
  minimum_items integer,
  maximum_items integer
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT
    jsonb_typeof(input_value) = 'array'
    AND jsonb_array_length(input_value) BETWEEN minimum_items AND maximum_items
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(input_value) AS item
      WHERE
        jsonb_typeof(item) <> 'string'
        OR (item #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
    AND jsonb_array_length(input_value) = (
      SELECT count(DISTINCT lower(item #>> '{}'))::integer
      FROM jsonb_array_elements(input_value) AS item
    );
$$;
--> statement-breakpoint
ALTER TABLE topic_candidates
  ADD COLUMN brief_suggestion_json jsonb,
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT topic_candidates_version_check CHECK (version > 0),
  ADD CONSTRAINT topic_candidates_id_scope_uq
    UNIQUE (id, tenant_id, workspace_id, project_id);
--> statement-breakpoint
ALTER TABLE topic_candidates
  DROP CONSTRAINT topic_candidates_entities_check,
  DROP CONSTRAINT topic_candidates_evidence_check,
  ADD CONSTRAINT topic_candidates_entities_check CHECK (
    COALESCE(
      jsonb_typeof(entities_json) = 'object'
      AND entities_json ?& ARRAY['schema_version', 'entities']
      AND entities_json - ARRAY['schema_version', 'entities']::text[] = '{}'::jsonb
      AND entities_json->>'schema_version' = 'entity-list@1'
      AND is_valid_nonblank_jsonb_string_array(entities_json->'entities', 1, 50),
      false
    )
  ),
  ADD CONSTRAINT topic_candidates_evidence_check CHECK (
    COALESCE(
      jsonb_typeof(evidence_summary_json) = 'object'
      AND evidence_summary_json ?& ARRAY['schema_version', 'evidence_ids']
      AND evidence_summary_json - ARRAY['schema_version', 'evidence_ids']::text[] = '{}'::jsonb
      AND evidence_summary_json->>'schema_version' = 'citation-set@1'
      AND is_valid_uuid_jsonb_array(evidence_summary_json->'evidence_ids', 0, 100),
      false
    )
  ),
  ADD CONSTRAINT topic_candidates_brief_suggestion_check CHECK (
    brief_suggestion_json IS NULL OR jsonb_typeof(brief_suggestion_json) = 'object'
  ),
  ADD CONSTRAINT topic_candidates_evidence_risk_check CHECK (
    jsonb_array_length(evidence_summary_json->'evidence_ids') > 0
    OR risk_level IN ('high', 'critical')
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_topic_candidate_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.id,
    NEW.tenant_id,
    NEW.workspace_id,
    NEW.project_id,
    NEW.generation_run_id,
    NEW.question,
    NEW.intent,
    NEW.entities_json,
    NEW.evidence_summary_json,
    NEW.platform_codes,
    NEW.priority,
    NEW.risk_level,
    NEW.brief_suggestion_json,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id,
    OLD.tenant_id,
    OLD.workspace_id,
    OLD.project_id,
    OLD.generation_run_id,
    OLD.question,
    OLD.intent,
    OLD.entities_json,
    OLD.evidence_summary_json,
    OLD.platform_codes,
    OLD.priority,
    OLD.risk_level,
    OLD.brief_suggestion_json,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'topic candidate source is immutable';
  END IF;
  IF NEW.status = OLD.status AND NEW.version = OLD.version THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'proposed'
    AND NEW.status IN ('adopted', 'archived')
    AND NEW.version = OLD.version + 1 THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid topic candidate status transition or version';
END;
$$;
--> statement-breakpoint
CREATE TABLE briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  source_topic_candidate_id uuid,
  title varchar(240) NOT NULL,
  objective varchar(32) NOT NULL,
  audience text NOT NULL,
  platform_codes varchar(24)[] NOT NULL,
  constraints_json jsonb NOT NULL,
  generation_mode varchar(16) NOT NULL DEFAULT 'draft',
  due_at timestamptz,
  created_by uuid NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT briefs_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT briefs_id_scope_uq UNIQUE (id, tenant_id, workspace_id, project_id),
  CONSTRAINT briefs_source_topic_uq UNIQUE (tenant_id, source_topic_candidate_id),
  CONSTRAINT briefs_workspace_fk
    FOREIGN KEY (workspace_id, tenant_id)
    REFERENCES workspaces(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT briefs_project_fk
    FOREIGN KEY (project_id, tenant_id, workspace_id)
    REFERENCES projects(id, tenant_id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT briefs_source_topic_fk
    FOREIGN KEY (source_topic_candidate_id, tenant_id)
    REFERENCES topic_candidates(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT briefs_created_by_fk
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT briefs_created_by_membership_fk
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT briefs_title_check CHECK (char_length(btrim(title)) BETWEEN 2 AND 80),
  CONSTRAINT briefs_objective_check
    CHECK (objective IN ('awareness', 'conversion', 'trust', 'education')),
  CONSTRAINT briefs_audience_check CHECK (char_length(btrim(audience)) BETWEEN 10 AND 500),
  CONSTRAINT briefs_platform_codes_check CHECK (is_valid_platform_code_array(platform_codes)),
  CONSTRAINT briefs_constraints_check CHECK (
    COALESCE(
      jsonb_typeof(constraints_json) = 'object'
      AND constraints_json->>'schema_version' = 'brief-constraints@1',
      false
    )
  ),
  CONSTRAINT briefs_generation_mode_check
    CHECK (generation_mode IN ('draft', 'rewrite', 'adapt', 'repurpose')),
  CONSTRAINT briefs_version_check CHECK (version > 0)
);
--> statement-breakpoint
CREATE INDEX briefs_scope_updated_idx
  ON briefs (tenant_id, workspace_id, project_id, updated_at DESC, id)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER briefs_set_updated_at
  BEFORE UPDATE ON briefs
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE brief_keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  brief_id uuid NOT NULL,
  keyword_id uuid NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brief_keywords_brief_keyword_uq UNIQUE (tenant_id, brief_id, keyword_id),
  CONSTRAINT brief_keywords_brief_fk
    FOREIGN KEY (brief_id, tenant_id)
    REFERENCES briefs(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT brief_keywords_keyword_fk
    FOREIGN KEY (keyword_id, tenant_id)
    REFERENCES keywords(id, tenant_id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX brief_keywords_one_primary_uq
  ON brief_keywords (tenant_id, brief_id)
  WHERE is_primary;
--> statement-breakpoint
CREATE INDEX brief_keywords_keyword_idx
  ON brief_keywords (tenant_id, keyword_id, brief_id);
--> statement-breakpoint
CREATE TABLE brief_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  brief_id uuid NOT NULL,
  source_document_id uuid NOT NULL,
  required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brief_sources_brief_source_uq
    UNIQUE (tenant_id, brief_id, source_document_id),
  CONSTRAINT brief_sources_brief_fk
    FOREIGN KEY (brief_id, tenant_id)
    REFERENCES briefs(id, tenant_id) ON DELETE CASCADE
);
--> statement-breakpoint
COMMENT ON TABLE brief_sources IS
  'Created for Topic adoption before knowledge tables exist; the knowledge/content schema migration must attach the tenant-scoped source_documents foreign key.';
