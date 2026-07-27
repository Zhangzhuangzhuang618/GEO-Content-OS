CREATE TABLE ai_visibility_query_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  series_id uuid NOT NULL DEFAULT gen_random_uuid(),
  revision integer NOT NULL DEFAULT 1,
  name varchar(120) NOT NULL,
  brand_name varchar(200) NOT NULL,
  brand_aliases_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  industry varchar(200) NOT NULL,
  market varchar(200),
  positioning text,
  competitor_names_json jsonb NOT NULL,
  locale varchar(16) NOT NULL DEFAULT 'zh-CN',
  status varchar(16) NOT NULL DEFAULT 'active',
  methodology_version varchar(64) NOT NULL DEFAULT 'ai-visibility@1',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_visibility_query_sets_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT ai_visibility_query_sets_id_scope_uq
    UNIQUE (id, tenant_id, workspace_id, project_id),
  CONSTRAINT ai_visibility_query_sets_series_revision_uq
    UNIQUE (tenant_id, series_id, revision),
  CONSTRAINT ai_visibility_query_sets_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT ai_visibility_query_sets_workspace_fk
    FOREIGN KEY (workspace_id, tenant_id)
    REFERENCES workspaces(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT ai_visibility_query_sets_project_fk
    FOREIGN KEY (project_id, tenant_id, workspace_id)
    REFERENCES projects(id, tenant_id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT ai_visibility_query_sets_created_by_fk
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT ai_visibility_query_sets_created_by_membership_fk
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT ai_visibility_query_sets_revision_check CHECK (revision > 0),
  CONSTRAINT ai_visibility_query_sets_name_check CHECK (char_length(btrim(name)) > 0),
  CONSTRAINT ai_visibility_query_sets_brand_check CHECK (char_length(btrim(brand_name)) > 0),
  CONSTRAINT ai_visibility_query_sets_industry_check CHECK (char_length(btrim(industry)) > 0),
  CONSTRAINT ai_visibility_query_sets_aliases_check CHECK (
    jsonb_typeof(brand_aliases_json) = 'array'
    AND jsonb_array_length(brand_aliases_json) <= 20
  ),
  CONSTRAINT ai_visibility_query_sets_competitors_check CHECK (
    jsonb_typeof(competitor_names_json) = 'array'
    AND jsonb_array_length(competitor_names_json) BETWEEN 2 AND 10
  ),
  CONSTRAINT ai_visibility_query_sets_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT ai_visibility_query_sets_methodology_check
    CHECK (char_length(btrim(methodology_version)) > 0)
);
--> statement-breakpoint
CREATE INDEX ai_visibility_query_sets_scope_idx
  ON ai_visibility_query_sets (
    tenant_id, workspace_id, project_id, status, created_at DESC, id
  );
--> statement-breakpoint
CREATE TRIGGER ai_visibility_query_sets_set_updated_at
  BEFORE UPDATE ON ai_visibility_query_sets
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE FUNCTION protect_ai_visibility_query_set_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.series_id IS DISTINCT FROM OLD.series_id
    OR NEW.revision IS DISTINCT FROM OLD.revision
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.brand_name IS DISTINCT FROM OLD.brand_name
    OR NEW.brand_aliases_json IS DISTINCT FROM OLD.brand_aliases_json
    OR NEW.industry IS DISTINCT FROM OLD.industry
    OR NEW.market IS DISTINCT FROM OLD.market
    OR NEW.positioning IS DISTINCT FROM OLD.positioning
    OR NEW.competitor_names_json IS DISTINCT FROM OLD.competitor_names_json
    OR NEW.locale IS DISTINCT FROM OLD.locale
    OR NEW.methodology_version IS DISTINCT FROM OLD.methodology_version
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'AI visibility query set versions are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ai_visibility_query_sets_version_guard
  BEFORE UPDATE ON ai_visibility_query_sets
  FOR EACH ROW
  EXECUTE FUNCTION protect_ai_visibility_query_set_version();
--> statement-breakpoint
CREATE TABLE ai_visibility_queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  query_set_id uuid NOT NULL,
  query_key varchar(16) NOT NULL,
  intent_code varchar(32) NOT NULL,
  query_text text NOT NULL,
  query_hash char(64) NOT NULL,
  commercial_value varchar(16) NOT NULL,
  sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_visibility_queries_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT ai_visibility_queries_set_key_uq
    UNIQUE (tenant_id, query_set_id, query_key),
  CONSTRAINT ai_visibility_queries_set_hash_uq
    UNIQUE (tenant_id, query_set_id, query_hash),
  CONSTRAINT ai_visibility_queries_query_set_fk
    FOREIGN KEY (query_set_id, tenant_id)
    REFERENCES ai_visibility_query_sets(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT ai_visibility_queries_key_check CHECK (query_key ~ '^q[0-9]{3}$'),
  CONSTRAINT ai_visibility_queries_intent_check CHECK (
    intent_code IN (
      'brand_recognition', 'exploration', 'recommendation',
      'comparison', 'education', 'procurement'
    )
  ),
  CONSTRAINT ai_visibility_queries_text_check CHECK (char_length(btrim(query_text)) > 0),
  CONSTRAINT ai_visibility_queries_hash_check CHECK (query_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ai_visibility_queries_commercial_check
    CHECK (commercial_value IN ('low', 'medium', 'high')),
  CONSTRAINT ai_visibility_queries_order_check CHECK (sort_order BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE INDEX ai_visibility_queries_set_order_idx
  ON ai_visibility_queries (tenant_id, query_set_id, sort_order, id);
--> statement-breakpoint
CREATE FUNCTION protect_ai_visibility_query_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AI visibility queries are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ai_visibility_queries_immutable_guard
  BEFORE UPDATE OR DELETE ON ai_visibility_queries
  FOR EACH ROW
  EXECUTE FUNCTION protect_ai_visibility_query_history();
--> statement-breakpoint
CREATE TABLE ai_visibility_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  query_set_id uuid NOT NULL,
  baseline_run_id uuid,
  engine_code varchar(32) NOT NULL,
  model_key varchar(120) NOT NULL,
  retrieval_mode varchar(24) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'queued',
  methodology_version varchar(64) NOT NULL,
  scoring_version varchar(64) NOT NULL DEFAULT 'ai-visibility-score@2',
  query_count integer NOT NULL,
  completed_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  score numeric(5,2),
  metrics_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  competitors_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  sources_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  opportunities_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_json jsonb,
  requested_by uuid NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_visibility_runs_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT ai_visibility_runs_id_scope_uq
    UNIQUE (id, tenant_id, workspace_id, project_id),
  CONSTRAINT ai_visibility_runs_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT ai_visibility_runs_query_set_fk
    FOREIGN KEY (query_set_id, tenant_id, workspace_id, project_id)
    REFERENCES ai_visibility_query_sets(id, tenant_id, workspace_id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT ai_visibility_runs_baseline_fk
    FOREIGN KEY (baseline_run_id, tenant_id, workspace_id, project_id)
    REFERENCES ai_visibility_runs(id, tenant_id, workspace_id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT ai_visibility_runs_requested_by_fk
    FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT ai_visibility_runs_requested_by_membership_fk
    FOREIGN KEY (tenant_id, requested_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT ai_visibility_runs_engine_check CHECK (
    engine_code IN ('deepseek', 'qwen', 'kimi', 'doubao', 'wenxin', 'yuanbao', 'custom')
  ),
  CONSTRAINT ai_visibility_runs_model_check CHECK (char_length(btrim(model_key)) > 0),
  CONSTRAINT ai_visibility_runs_retrieval_check
    CHECK (retrieval_mode IN ('model_only', 'search_api', 'imported')),
  CONSTRAINT ai_visibility_runs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
  CONSTRAINT ai_visibility_runs_count_check CHECK (
    query_count BETWEEN 1 AND 100
    AND completed_count BETWEEN 0 AND query_count
    AND failed_count BETWEEN 0 AND query_count
    AND completed_count + failed_count <= query_count
  ),
  CONSTRAINT ai_visibility_runs_score_check CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  CONSTRAINT ai_visibility_runs_metrics_check CHECK (jsonb_typeof(metrics_json) = 'object'),
  CONSTRAINT ai_visibility_runs_competitors_check CHECK (jsonb_typeof(competitors_json) = 'array'),
  CONSTRAINT ai_visibility_runs_sources_check CHECK (jsonb_typeof(sources_json) = 'array'),
  CONSTRAINT ai_visibility_runs_opportunities_check CHECK (jsonb_typeof(opportunities_json) = 'array'),
  CONSTRAINT ai_visibility_runs_error_check
    CHECK (error_json IS NULL OR jsonb_typeof(error_json) = 'object'),
  CONSTRAINT ai_visibility_runs_version_check CHECK (version > 0)
);
--> statement-breakpoint
CREATE INDEX ai_visibility_runs_scope_time_idx
  ON ai_visibility_runs (
    tenant_id, workspace_id, project_id, created_at DESC, id
  );
--> statement-breakpoint
CREATE INDEX ai_visibility_runs_set_engine_idx
  ON ai_visibility_runs (
    tenant_id, query_set_id, engine_code, created_at DESC, id
  );
--> statement-breakpoint
CREATE TRIGGER ai_visibility_runs_set_updated_at
  BEFORE UPDATE ON ai_visibility_runs
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE ai_visibility_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  query_id uuid NOT NULL,
  sample_index integer NOT NULL DEFAULT 1,
  answer_text text,
  response_hash char(64),
  target_mentioned boolean NOT NULL DEFAULT false,
  target_rank integer,
  recommended boolean NOT NULL DEFAULT false,
  sentiment varchar(16) NOT NULL DEFAULT 'unknown',
  recognition_status varchar(24) NOT NULL DEFAULT 'not_applicable',
  competitors_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  citations_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_request_id varchar(200),
  usage_json jsonb,
  error_json jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_visibility_responses_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT ai_visibility_responses_run_query_sample_uq
    UNIQUE (tenant_id, run_id, query_id, sample_index),
  CONSTRAINT ai_visibility_responses_run_fk
    FOREIGN KEY (run_id, tenant_id)
    REFERENCES ai_visibility_runs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT ai_visibility_responses_query_fk
    FOREIGN KEY (query_id, tenant_id)
    REFERENCES ai_visibility_queries(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT ai_visibility_responses_sample_check CHECK (sample_index BETWEEN 1 AND 10),
  CONSTRAINT ai_visibility_responses_answer_check CHECK (
    (answer_text IS NOT NULL AND char_length(btrim(answer_text)) > 0 AND error_json IS NULL)
    OR (answer_text IS NULL AND error_json IS NOT NULL)
  ),
  CONSTRAINT ai_visibility_responses_hash_check CHECK (
    response_hash IS NULL OR response_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ai_visibility_responses_rank_check CHECK (target_rank IS NULL OR target_rank > 0),
  CONSTRAINT ai_visibility_responses_sentiment_check
    CHECK (sentiment IN ('positive', 'neutral', 'negative', 'unknown')),
  CONSTRAINT ai_visibility_responses_recognition_check CHECK (
    recognition_status IN (
      'not_applicable', 'recognized', 'not_recognized', 'misidentified', 'uncertain'
    )
  ),
  CONSTRAINT ai_visibility_responses_competitors_check
    CHECK (jsonb_typeof(competitors_json) = 'array'),
  CONSTRAINT ai_visibility_responses_citations_check CHECK (jsonb_typeof(citations_json) = 'array'),
  CONSTRAINT ai_visibility_responses_usage_check
    CHECK (usage_json IS NULL OR jsonb_typeof(usage_json) = 'object'),
  CONSTRAINT ai_visibility_responses_error_check
    CHECK (error_json IS NULL OR jsonb_typeof(error_json) = 'object')
);
--> statement-breakpoint
CREATE INDEX ai_visibility_responses_run_order_idx
  ON ai_visibility_responses (tenant_id, run_id, created_at, id);
--> statement-breakpoint
CREATE FUNCTION enforce_ai_visibility_response_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM ai_visibility_runs AS run
    JOIN ai_visibility_queries AS query
      ON query.id = NEW.query_id
      AND query.tenant_id = NEW.tenant_id
    WHERE run.id = NEW.run_id
      AND run.tenant_id = NEW.tenant_id
      AND query.query_set_id = run.query_set_id
  ) THEN
    RAISE EXCEPTION 'AI visibility response query must belong to the run query set';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ai_visibility_responses_scope_guard
  BEFORE INSERT ON ai_visibility_responses
  FOR EACH ROW
  EXECUTE FUNCTION enforce_ai_visibility_response_scope();
--> statement-breakpoint
CREATE FUNCTION protect_ai_visibility_response_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AI visibility responses are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ai_visibility_responses_append_only_guard
  BEFORE UPDATE OR DELETE ON ai_visibility_responses
  FOR EACH ROW
  EXECUTE FUNCTION protect_ai_visibility_response_history();
