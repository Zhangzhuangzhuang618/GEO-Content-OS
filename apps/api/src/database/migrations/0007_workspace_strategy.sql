CREATE FUNCTION is_valid_platform_code_array(input_codes varchar[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT
    cardinality(input_codes) BETWEEN 1 AND 7
    AND array_position(input_codes, NULL) IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(input_codes) AS code
      WHERE code NOT IN (
        'official_site',
        'baijiahao',
        'toutiao',
        'zhihu',
        'xiaohongshu',
        'wechat_mp',
        'douyin'
      )
    )
    AND cardinality(input_codes) = (
      SELECT count(DISTINCT code)::integer FROM unnest(input_codes) AS code
    );
$$;
--> statement-breakpoint
CREATE FUNCTION is_valid_nonblank_text_array(input_values text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT
    array_position(input_values, NULL) IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM unnest(input_values) AS item WHERE btrim(item) = ''
    )
    AND cardinality(input_values) = (
      SELECT count(DISTINCT lower(btrim(item)))::integer
      FROM unnest(input_values) AS item
    );
$$;
--> statement-breakpoint
CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name varchar(120) NOT NULL,
  slug citext NOT NULL,
  timezone varchar(64) NOT NULL,
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(16) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT workspaces_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT workspaces_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT workspaces_name_check
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT workspaces_slug_check CHECK (
    char_length(slug::text) BETWEEN 1 AND 80
    AND slug::text ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  ),
  CONSTRAINT workspaces_timezone_check
    CHECK (char_length(btrim(timezone)) BETWEEN 1 AND 64),
  CONSTRAINT workspaces_settings_check CHECK (
    COALESCE(
      jsonb_typeof(settings_json) = 'object'
      AND (
        settings_json = '{}'::jsonb
        OR settings_json->>'schema_version' = 'workspace-settings@1'
      ),
      false
    )
  ),
  CONSTRAINT workspaces_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT workspaces_deleted_status_check
    CHECK (deleted_at IS NULL OR status = 'archived')
);
--> statement-breakpoint
CREATE UNIQUE INDEX workspaces_tenant_slug_active_uq
  ON workspaces (tenant_id, slug)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX workspaces_tenant_status_idx
  ON workspaces (tenant_id, status, updated_at DESC, id)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER workspaces_set_updated_at
  BEFORE UPDATE ON workspaces
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE workspace_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  scope_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_memberships_workspace_user_uq UNIQUE (workspace_id, user_id),
  CONSTRAINT workspace_memberships_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CONSTRAINT workspace_memberships_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT workspace_memberships_scope_check CHECK (
    COALESCE(
      jsonb_typeof(scope_json) = 'object'
      AND (
        scope_json = '{}'::jsonb
        OR scope_json->>'schema_version' = 'workspace-scope@1'
      ),
      false
    )
  )
);
--> statement-breakpoint
CREATE INDEX workspace_memberships_user_idx
  ON workspace_memberships (user_id, workspace_id);
--> statement-breakpoint
CREATE TRIGGER workspace_memberships_set_updated_at
  BEFORE UPDATE ON workspace_memberships
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE FUNCTION enforce_workspace_member_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM workspaces AS workspace
    JOIN memberships AS membership
      ON membership.tenant_id = workspace.tenant_id
      AND membership.user_id = NEW.user_id
    WHERE workspace.id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'workspace member must belong to the workspace tenant';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER workspace_memberships_tenant_guard
  BEFORE INSERT OR UPDATE OF workspace_id, user_id ON workspace_memberships
  FOR EACH ROW
  EXECUTE FUNCTION enforce_workspace_member_tenant();
--> statement-breakpoint
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name varchar(160) NOT NULL,
  owner_id uuid NOT NULL,
  objective text,
  status varchar(16) NOT NULL DEFAULT 'active',
  start_date date,
  end_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT projects_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT projects_id_tenant_workspace_uq UNIQUE (id, tenant_id, workspace_id),
  CONSTRAINT projects_workspace_fk
    FOREIGN KEY (workspace_id, tenant_id)
    REFERENCES workspaces(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT projects_owner_fk
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT projects_owner_membership_fk
    FOREIGN KEY (tenant_id, owner_id)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT projects_name_check
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  CONSTRAINT projects_objective_check
    CHECK (objective IS NULL OR char_length(btrim(objective)) BETWEEN 1 AND 10000),
  CONSTRAINT projects_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT projects_date_range_check
    CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date),
  CONSTRAINT projects_deleted_status_check
    CHECK (deleted_at IS NULL OR status = 'archived')
);
--> statement-breakpoint
CREATE INDEX projects_workspace_status_idx
  ON projects (tenant_id, workspace_id, status, updated_at DESC, id)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX projects_owner_status_idx
  ON projects (tenant_id, owner_id, status, updated_at DESC)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER projects_set_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE brand_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  version integer NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'draft',
  schema_version varchar(32) NOT NULL,
  profile_json jsonb NOT NULL,
  created_by uuid NOT NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brand_profiles_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT brand_profiles_workspace_version_uq
    UNIQUE (tenant_id, workspace_id, version),
  CONSTRAINT brand_profiles_workspace_fk
    FOREIGN KEY (workspace_id, tenant_id)
    REFERENCES workspaces(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT brand_profiles_created_by_fk
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT brand_profiles_created_by_membership_fk
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT brand_profiles_version_check CHECK (version > 0),
  CONSTRAINT brand_profiles_status_check
    CHECK (status IN ('draft', 'published', 'retired')),
  CONSTRAINT brand_profiles_schema_version_check
    CHECK (char_length(btrim(schema_version)) BETWEEN 1 AND 32),
  CONSTRAINT brand_profiles_profile_check
    CHECK (COALESCE(jsonb_typeof(profile_json) = 'object', false)),
  CONSTRAINT brand_profiles_publication_check CHECK (
    (status = 'draft' AND published_at IS NULL)
    OR (status IN ('published', 'retired') AND published_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX brand_profiles_one_published_uq
  ON brand_profiles (tenant_id, workspace_id)
  WHERE status = 'published';
--> statement-breakpoint
CREATE INDEX brand_profiles_workspace_status_idx
  ON brand_profiles (tenant_id, workspace_id, status, version DESC);
--> statement-breakpoint
CREATE FUNCTION protect_brand_profile_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.id,
    NEW.tenant_id,
    NEW.workspace_id,
    NEW.version,
    NEW.schema_version,
    NEW.profile_json,
    NEW.created_by,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id,
    OLD.tenant_id,
    OLD.workspace_id,
    OLD.version,
    OLD.schema_version,
    OLD.profile_json,
    OLD.created_by,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'brand profile version content is immutable';
  END IF;

  IF NEW.status = OLD.status AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'published' AND NEW.published_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'published' AND NEW.status = 'retired'
    AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid brand profile status transition';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER brand_profiles_version_guard
  BEFORE UPDATE ON brand_profiles
  FOR EACH ROW
  EXECUTE FUNCTION protect_brand_profile_version();
--> statement-breakpoint
CREATE TABLE keyword_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name varchar(120) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT keyword_sets_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT keyword_sets_project_fk
    FOREIGN KEY (project_id, tenant_id)
    REFERENCES projects(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT keyword_sets_name_check
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT keyword_sets_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT keyword_sets_deleted_status_check
    CHECK (deleted_at IS NULL OR status = 'archived')
);
--> statement-breakpoint
CREATE UNIQUE INDEX keyword_sets_project_name_active_uq
  ON keyword_sets (tenant_id, project_id, name)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX keyword_sets_project_status_idx
  ON keyword_sets (tenant_id, project_id, status, updated_at DESC, id)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER keyword_sets_set_updated_at
  BEFORE UPDATE ON keyword_sets
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  keyword_set_id uuid NOT NULL,
  term citext NOT NULL,
  intent varchar(32) NOT NULL,
  priority smallint NOT NULL DEFAULT 50,
  synonyms text[] NOT NULL DEFAULT '{}'::text[],
  platform_scope varchar(24)[] NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT keywords_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT keywords_keyword_set_fk
    FOREIGN KEY (keyword_set_id, tenant_id)
    REFERENCES keyword_sets(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT keywords_set_term_uq UNIQUE (tenant_id, keyword_set_id, term),
  CONSTRAINT keywords_term_check
    CHECK (char_length(btrim(term::text)) BETWEEN 1 AND 240),
  CONSTRAINT keywords_intent_check CHECK (
    intent IN ('informational', 'commercial', 'transactional', 'navigational')
  ),
  CONSTRAINT keywords_priority_check CHECK (priority BETWEEN 0 AND 100),
  CONSTRAINT keywords_synonyms_check CHECK (is_valid_nonblank_text_array(synonyms)),
  CONSTRAINT keywords_platform_scope_check
    CHECK (is_valid_platform_code_array(platform_scope)),
  CONSTRAINT keywords_status_check CHECK (status IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE INDEX keywords_set_status_priority_idx
  ON keywords (tenant_id, keyword_set_id, status, priority DESC, id);
--> statement-breakpoint
CREATE INDEX keywords_term_lookup_idx
  ON keywords (tenant_id, term);
--> statement-breakpoint
CREATE TRIGGER keywords_set_updated_at
  BEFORE UPDATE ON keywords
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE generation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid,
  package_id uuid,
  variant_id uuid,
  skill_name varchar(80) NOT NULL,
  skill_version varchar(32) NOT NULL,
  prompt_version_id uuid NOT NULL,
  model_key varchar(80) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'queued',
  input_hash char(64) NOT NULL,
  request_id varchar(80) NOT NULL,
  error_json jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT generation_runs_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT generation_runs_topic_scope_uq
    UNIQUE (id, tenant_id, workspace_id, project_id),
  CONSTRAINT generation_runs_workspace_fk
    FOREIGN KEY (workspace_id, tenant_id)
    REFERENCES workspaces(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT generation_runs_project_fk
    FOREIGN KEY (project_id, tenant_id, workspace_id)
    REFERENCES projects(id, tenant_id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT generation_runs_skill_name_check
    CHECK (char_length(btrim(skill_name)) BETWEEN 1 AND 80),
  CONSTRAINT generation_runs_skill_version_check CHECK (
    char_length(btrim(skill_version)) BETWEEN 1 AND 32
    AND skill_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$'
  ),
  CONSTRAINT generation_runs_model_key_check
    CHECK (char_length(btrim(model_key)) BETWEEN 1 AND 80),
  CONSTRAINT generation_runs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT generation_runs_input_hash_check CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT generation_runs_request_id_check
    CHECK (char_length(btrim(request_id)) BETWEEN 1 AND 80),
  CONSTRAINT generation_runs_error_check
    CHECK (error_json IS NULL OR jsonb_typeof(error_json) = 'object'),
  CONSTRAINT generation_runs_time_check CHECK (
    (started_at IS NULL OR started_at >= created_at)
    AND (finished_at IS NULL OR started_at IS NOT NULL)
    AND (finished_at IS NULL OR finished_at >= started_at)
  )
);
--> statement-breakpoint
COMMENT ON TABLE generation_runs IS
  'Created with workspace strategy because topic_candidates requires a run FK; content migrations add package, variant, and prompt FKs when those tables exist.';
--> statement-breakpoint
CREATE INDEX generation_runs_request_idx
  ON generation_runs (request_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX generation_runs_scope_status_idx
  ON generation_runs (tenant_id, workspace_id, project_id, status, created_at DESC);
--> statement-breakpoint
CREATE TRIGGER generation_runs_set_updated_at
  BEFORE UPDATE ON generation_runs
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE topic_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  generation_run_id uuid NOT NULL,
  question text NOT NULL,
  intent varchar(32) NOT NULL,
  entities_json jsonb NOT NULL,
  evidence_summary_json jsonb NOT NULL,
  platform_codes varchar(24)[] NOT NULL,
  priority smallint NOT NULL,
  risk_level varchar(16) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'proposed',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topic_candidates_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT topic_candidates_workspace_fk
    FOREIGN KEY (workspace_id, tenant_id)
    REFERENCES workspaces(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT topic_candidates_project_fk
    FOREIGN KEY (project_id, tenant_id, workspace_id)
    REFERENCES projects(id, tenant_id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT topic_candidates_generation_run_fk
    FOREIGN KEY (generation_run_id, tenant_id, workspace_id, project_id)
    REFERENCES generation_runs(id, tenant_id, workspace_id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT topic_candidates_question_check
    CHECK (char_length(btrim(question)) BETWEEN 5 AND 2000),
  CONSTRAINT topic_candidates_intent_check
    CHECK (char_length(btrim(intent)) BETWEEN 1 AND 32),
  CONSTRAINT topic_candidates_entities_check CHECK (
    COALESCE(
      jsonb_typeof(entities_json) = 'object'
      AND entities_json->>'schema_version' = 'entity-list@1'
      AND jsonb_typeof(entities_json->'entities') = 'array'
      AND jsonb_array_length(entities_json->'entities') > 0
      AND NOT jsonb_path_exists(
        entities_json,
        '$.entities[*] ? (@.type() != "string" || @ == "")'
      ),
      false
    )
  ),
  CONSTRAINT topic_candidates_evidence_check CHECK (
    COALESCE(
      jsonb_typeof(evidence_summary_json) = 'object'
      AND evidence_summary_json->>'schema_version' = 'citation-set@1'
      AND jsonb_typeof(evidence_summary_json->'evidence_ids') = 'array',
      false
    )
  ),
  CONSTRAINT topic_candidates_platform_codes_check
    CHECK (is_valid_platform_code_array(platform_codes)),
  CONSTRAINT topic_candidates_priority_check CHECK (priority BETWEEN 0 AND 100),
  CONSTRAINT topic_candidates_risk_check
    CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT topic_candidates_status_check
    CHECK (status IN ('proposed', 'adopted', 'archived'))
);
--> statement-breakpoint
CREATE INDEX topic_candidates_scope_status_idx
  ON topic_candidates (
    tenant_id,
    workspace_id,
    project_id,
    status,
    priority DESC,
    created_at DESC,
    id
  );
--> statement-breakpoint
CREATE INDEX topic_candidates_run_idx
  ON topic_candidates (tenant_id, generation_run_id, created_at, id);
--> statement-breakpoint
CREATE TRIGGER topic_candidates_set_updated_at
  BEFORE UPDATE ON topic_candidates
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE FUNCTION protect_topic_candidate_source()
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
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'topic candidate source is immutable';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'proposed' AND NEW.status IN ('adopted', 'archived') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid topic candidate status transition';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER topic_candidates_source_guard
  BEFORE UPDATE ON topic_candidates
  FOR EACH ROW
  EXECUTE FUNCTION protect_topic_candidate_source();
