CREATE TABLE source_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid,
  title varchar(240) NOT NULL,
  source_type varchar(24) NOT NULL,
  mime_type varchar(120) NOT NULL,
  language varchar(16) NOT NULL DEFAULT 'zh-CN',
  uri text NOT NULL,
  content_hash char(64) NOT NULL,
  trust_level varchar(16) NOT NULL DEFAULT 'normal',
  effective_from date,
  effective_to date,
  status varchar(16) NOT NULL DEFAULT 'processing',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT source_documents_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT source_documents_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT source_documents_workspace_fk
    FOREIGN KEY (workspace_id, tenant_id)
    REFERENCES workspaces(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT source_documents_project_fk
    FOREIGN KEY (project_id, tenant_id, workspace_id)
    REFERENCES projects(id, tenant_id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT source_documents_created_by_fk
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT source_documents_created_by_membership_fk
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT source_documents_title_check
    CHECK (char_length(btrim(title)) BETWEEN 1 AND 240),
  CONSTRAINT source_documents_type_mime_check CHECK (
    (source_type = 'pdf' AND mime_type = 'application/pdf')
    OR (
      source_type = 'docx'
      AND mime_type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
    OR (source_type = 'txt' AND mime_type = 'text/plain')
    OR (source_type = 'url' AND mime_type IN ('text/html', 'application/xhtml+xml'))
    OR (source_type = 'image' AND mime_type IN ('image/png', 'image/jpeg', 'image/webp'))
  ),
  CONSTRAINT source_documents_language_check
    CHECK (language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  CONSTRAINT source_documents_uri_check
    CHECK (char_length(btrim(uri)) BETWEEN 1 AND 8192),
  CONSTRAINT source_documents_content_hash_check
    CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT source_documents_trust_level_check
    CHECK (trust_level IN ('verified', 'normal', 'untrusted')),
  CONSTRAINT source_documents_effective_range_check
    CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from),
  CONSTRAINT source_documents_status_check
    CHECK (status IN ('processing', 'active', 'expired', 'failed')),
  CONSTRAINT source_documents_deleted_status_check
    CHECK (deleted_at IS NULL OR status IN ('expired', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_source_hash_active
  ON source_documents (tenant_id, workspace_id, content_hash)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX source_documents_scope_status_idx
  ON source_documents (
    tenant_id,
    workspace_id,
    project_id,
    status,
    updated_at DESC,
    id
  )
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER source_documents_set_updated_at
  BEFORE UPDATE ON source_documents
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE ingest_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  source_document_id uuid NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'queued',
  attempt_count smallint NOT NULL DEFAULT 0,
  stage varchar(24) NOT NULL DEFAULT 'queued',
  progress smallint NOT NULL DEFAULT 0,
  error_json jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingest_jobs_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT ingest_jobs_source_fk
    FOREIGN KEY (source_document_id, tenant_id)
    REFERENCES source_documents(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT ingest_jobs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT ingest_jobs_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT ingest_jobs_stage_check
    CHECK (stage IN ('queued', 'upload', 'scan', 'parse', 'chunk', 'embed', 'index', 'done')),
  CONSTRAINT ingest_jobs_progress_check CHECK (progress BETWEEN 0 AND 100),
  CONSTRAINT ingest_jobs_error_check CHECK (
    error_json IS NULL
    OR COALESCE(
      jsonb_typeof(error_json) = 'object'
      AND error_json->>'schema_version' = 'job-error@1'
      AND char_length(btrim(error_json->>'code')) BETWEEN 1 AND 80
      AND char_length(btrim(error_json->>'message')) BETWEEN 1 AND 2000,
      false
    )
  ),
  CONSTRAINT ingest_jobs_temporal_check
    CHECK (finished_at IS NULL OR (started_at IS NOT NULL AND finished_at >= started_at)),
  CONSTRAINT ingest_jobs_terminal_check CHECK (
    (status = 'queued' AND started_at IS NULL AND finished_at IS NULL)
    OR (status = 'running' AND started_at IS NOT NULL AND finished_at IS NULL)
    OR (status = 'succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND stage = 'done' AND progress = 100 AND error_json IS NULL)
    OR (status = 'failed' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND error_json IS NOT NULL)
    OR (status = 'cancelled' AND finished_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX ingest_jobs_source_created_idx
  ON ingest_jobs (tenant_id, source_document_id, created_at DESC, id);
--> statement-breakpoint
CREATE INDEX ingest_jobs_pending_idx
  ON ingest_jobs (created_at, id)
  WHERE status = 'queued';
--> statement-breakpoint
CREATE TRIGGER ingest_jobs_set_updated_at
  BEFORE UPDATE ON ingest_jobs
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE source_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  source_document_id uuid NOT NULL,
  chunk_no integer NOT NULL,
  text text NOT NULL,
  text_hash char(64) NOT NULL,
  metadata_json jsonb NOT NULL,
  token_count integer NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
  status varchar(16) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_chunks_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT source_chunks_source_chunk_uq
    UNIQUE (tenant_id, source_document_id, chunk_no),
  CONSTRAINT source_chunks_source_fk
    FOREIGN KEY (source_document_id, tenant_id)
    REFERENCES source_documents(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT source_chunks_chunk_no_check CHECK (chunk_no >= 0),
  CONSTRAINT source_chunks_text_check CHECK (char_length(btrim(text)) > 0),
  CONSTRAINT source_chunks_text_hash_check CHECK (text_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT source_chunks_metadata_check CHECK (
    COALESCE(
      jsonb_typeof(metadata_json) = 'object'
      AND metadata_json->>'schema_version' = 'chunk-metadata@1'
      AND metadata_json - ARRAY[
        'schema_version', 'page', 'url', 'char_start', 'char_end', 'headings'
      ]::text[] = '{}'::jsonb
      AND (
        NOT metadata_json ? 'page'
        OR (
          jsonb_typeof(metadata_json->'page') = 'number'
          AND (metadata_json->>'page')::numeric = trunc((metadata_json->>'page')::numeric)
          AND (metadata_json->>'page')::numeric > 0
        )
      )
      AND (
        NOT metadata_json ? 'url'
        OR (
          jsonb_typeof(metadata_json->'url') = 'string'
          AND char_length(btrim(metadata_json->>'url')) BETWEEN 1 AND 8192
        )
      )
      AND (
        NOT metadata_json ? 'char_start'
        OR (
          jsonb_typeof(metadata_json->'char_start') = 'number'
          AND (metadata_json->>'char_start')::numeric = trunc((metadata_json->>'char_start')::numeric)
          AND (metadata_json->>'char_start')::numeric >= 0
        )
      )
      AND (
        NOT metadata_json ? 'char_end'
        OR (
          jsonb_typeof(metadata_json->'char_end') = 'number'
          AND (metadata_json->>'char_end')::numeric = trunc((metadata_json->>'char_end')::numeric)
          AND (metadata_json->>'char_end')::numeric >= 0
        )
      )
      AND (
        NOT (metadata_json ? 'char_start' AND metadata_json ? 'char_end')
        OR (metadata_json->>'char_end')::numeric >= (metadata_json->>'char_start')::numeric
      )
      AND (
        NOT metadata_json ? 'headings'
        OR is_valid_nonblank_jsonb_string_array(metadata_json->'headings', 0, 32)
      ),
      false
    )
  ),
  CONSTRAINT source_chunks_token_count_check CHECK (token_count > 0),
  CONSTRAINT source_chunks_status_check CHECK (status IN ('active', 'inactive'))
);
--> statement-breakpoint
CREATE INDEX source_chunks_search_vector_idx
  ON source_chunks USING gin (search_vector);
--> statement-breakpoint
CREATE INDEX source_chunks_source_status_idx
  ON source_chunks (tenant_id, source_document_id, status, chunk_no, id);
--> statement-breakpoint
CREATE TABLE embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  chunk_id uuid NOT NULL,
  model_key varchar(80) NOT NULL,
  dimension smallint NOT NULL DEFAULT 1536,
  embedding vector(1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT embeddings_chunk_model_uq UNIQUE (tenant_id, chunk_id, model_key),
  CONSTRAINT embeddings_chunk_fk
    FOREIGN KEY (chunk_id, tenant_id)
    REFERENCES source_chunks(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT embeddings_model_key_check
    CHECK (char_length(btrim(model_key)) BETWEEN 1 AND 80),
  CONSTRAINT embeddings_dimension_check CHECK (dimension = 1536)
);
--> statement-breakpoint
CREATE INDEX embeddings_vector_hnsw_idx
  ON embeddings USING hnsw (embedding vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX embeddings_tenant_model_idx
  ON embeddings (tenant_id, model_key, chunk_id);
--> statement-breakpoint
CREATE TABLE facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  subject varchar(240) NOT NULL,
  predicate varchar(120) NOT NULL,
  object_value text NOT NULL,
  unit varchar(32),
  valid_from date,
  valid_to date,
  confidence numeric(5,4) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'candidate',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT facts_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT facts_workspace_fk
    FOREIGN KEY (workspace_id, tenant_id)
    REFERENCES workspaces(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT facts_subject_check CHECK (char_length(btrim(subject)) BETWEEN 1 AND 240),
  CONSTRAINT facts_predicate_check CHECK (char_length(btrim(predicate)) BETWEEN 1 AND 120),
  CONSTRAINT facts_object_value_check CHECK (char_length(btrim(object_value)) > 0),
  CONSTRAINT facts_unit_check CHECK (unit IS NULL OR char_length(btrim(unit)) BETWEEN 1 AND 32),
  CONSTRAINT facts_valid_range_check
    CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  CONSTRAINT facts_confidence_check CHECK (confidence BETWEEN 0 AND 1),
  CONSTRAINT facts_status_check
    CHECK (status IN ('candidate', 'verified', 'conflicted', 'retired'))
);
--> statement-breakpoint
CREATE INDEX facts_subject_predicate_status_idx
  ON facts (tenant_id, workspace_id, subject, predicate, status);
--> statement-breakpoint
CREATE TRIGGER facts_set_updated_at
  BEFORE UPDATE ON facts
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE fact_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  fact_id uuid NOT NULL,
  chunk_id uuid NOT NULL,
  quote_text text NOT NULL,
  quote_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fact_sources_fact_chunk_quote_uq
    UNIQUE (tenant_id, fact_id, chunk_id, quote_hash),
  CONSTRAINT fact_sources_fact_fk
    FOREIGN KEY (fact_id, tenant_id)
    REFERENCES facts(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT fact_sources_chunk_fk
    FOREIGN KEY (chunk_id, tenant_id)
    REFERENCES source_chunks(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fact_sources_quote_text_check CHECK (char_length(btrim(quote_text)) > 0),
  CONSTRAINT fact_sources_quote_hash_check CHECK (quote_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX fact_sources_chunk_idx
  ON fact_sources (tenant_id, chunk_id, fact_id);
--> statement-breakpoint
CREATE FUNCTION enforce_fact_source_workspace()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM facts AS fact
    JOIN source_chunks AS chunk
      ON chunk.id = NEW.chunk_id
      AND chunk.tenant_id = NEW.tenant_id
    JOIN source_documents AS source
      ON source.id = chunk.source_document_id
      AND source.tenant_id = chunk.tenant_id
    WHERE
      fact.id = NEW.fact_id
      AND fact.tenant_id = NEW.tenant_id
      AND fact.workspace_id = source.workspace_id
  ) THEN
    RAISE EXCEPTION 'fact source must belong to the fact workspace';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER fact_sources_workspace_guard
  BEFORE INSERT ON fact_sources
  FOR EACH ROW
  EXECUTE FUNCTION enforce_fact_source_workspace();
--> statement-breakpoint
CREATE FUNCTION protect_fact_source_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'fact sources are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER fact_sources_append_only_guard
  BEFORE UPDATE OR DELETE ON fact_sources
  FOR EACH ROW
  EXECUTE FUNCTION protect_fact_source_history();
--> statement-breakpoint
ALTER TABLE brief_sources
  ADD CONSTRAINT brief_sources_source_document_fk
  FOREIGN KEY (source_document_id, tenant_id)
  REFERENCES source_documents(id, tenant_id) ON DELETE RESTRICT;
--> statement-breakpoint
COMMENT ON TABLE brief_sources IS
  'Required source documents selected for a brief; references are tenant-scoped and deletion-restricted.';
