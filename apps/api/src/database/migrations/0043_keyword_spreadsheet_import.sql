CREATE TABLE keyword_import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  keyword_set_id uuid NOT NULL,
  file_name varchar(255) NOT NULL,
  content_hash char(64) NOT NULL,
  sheet_name varchar(120) NOT NULL,
  header_row integer NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'preflight_ready',
  total_row_count integer NOT NULL,
  candidate_count integer NOT NULL,
  folded_row_count integer NOT NULL,
  invalid_row_count integer NOT NULL,
  selected_count integer NOT NULL DEFAULT 0,
  imported_count integer NOT NULL DEFAULT 0,
  last_row_number integer NOT NULL DEFAULT 0,
  summary_json jsonb NOT NULL,
  options_json jsonb,
  error_json jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT keyword_import_jobs_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT keyword_import_jobs_keyword_set_fk
    FOREIGN KEY (keyword_set_id, tenant_id)
    REFERENCES keyword_sets(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT keyword_import_jobs_created_by_membership_fk
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT keyword_import_jobs_file_name_check
    CHECK (char_length(btrim(file_name)) BETWEEN 1 AND 255),
  CONSTRAINT keyword_import_jobs_hash_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT keyword_import_jobs_sheet_name_check
    CHECK (char_length(btrim(sheet_name)) BETWEEN 1 AND 120),
  CONSTRAINT keyword_import_jobs_header_row_check CHECK (header_row BETWEEN 1 AND 50),
  CONSTRAINT keyword_import_jobs_status_check CHECK (
    status IN ('preflight_ready', 'queued', 'running', 'succeeded', 'failed')
  ),
  CONSTRAINT keyword_import_jobs_counts_check CHECK (
    total_row_count BETWEEN 0 AND 100000
    AND candidate_count BETWEEN 0 AND total_row_count
    AND folded_row_count BETWEEN 0 AND total_row_count
    AND invalid_row_count BETWEEN 0 AND total_row_count
    AND candidate_count + folded_row_count + invalid_row_count = total_row_count
    AND selected_count BETWEEN 0 AND candidate_count
    AND imported_count BETWEEN 0 AND selected_count
    AND last_row_number BETWEEN 0 AND 100000
  ),
  CONSTRAINT keyword_import_jobs_summary_check CHECK (
    jsonb_typeof(summary_json) = 'object'
    AND summary_json ?& ARRAY['source_intents', 'page_types', 'candidate_samples']::text[]
  ),
  CONSTRAINT keyword_import_jobs_options_check CHECK (
    options_json IS NULL OR jsonb_typeof(options_json) = 'object'
  ),
  CONSTRAINT keyword_import_jobs_error_check CHECK (
    (status = 'failed' AND error_json IS NOT NULL)
    OR (status <> 'failed' AND error_json IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX keyword_import_jobs_set_status_idx
  ON keyword_import_jobs (tenant_id, keyword_set_id, status, created_at DESC);
--> statement-breakpoint
CREATE TRIGGER keyword_import_jobs_set_updated_at
  BEFORE UPDATE ON keyword_import_jobs
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE keyword_import_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  import_job_id uuid NOT NULL,
  row_number integer NOT NULL,
  term citext NOT NULL,
  intents varchar(32)[] NOT NULL,
  synonyms text[] NOT NULL DEFAULT '{}',
  source_intent varchar(80) NOT NULL,
  suggested_page_type varchar(80) NOT NULL,
  cluster_key char(64) NOT NULL,
  metadata_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT keyword_import_candidates_job_fk
    FOREIGN KEY (import_job_id, tenant_id)
    REFERENCES keyword_import_jobs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT keyword_import_candidates_row_uq
    UNIQUE (tenant_id, import_job_id, row_number),
  CONSTRAINT keyword_import_candidates_term_uq
    UNIQUE (tenant_id, import_job_id, term),
  CONSTRAINT keyword_import_candidates_cluster_uq
    UNIQUE (tenant_id, import_job_id, cluster_key),
  CONSTRAINT keyword_import_candidates_row_check CHECK (row_number BETWEEN 1 AND 100000),
  CONSTRAINT keyword_import_candidates_term_check
    CHECK (char_length(btrim(term::text)) BETWEEN 1 AND 240),
  CONSTRAINT keyword_import_candidates_intents_check CHECK (
    cardinality(intents) BETWEEN 1 AND 4
    AND array_position(intents, NULL) IS NULL
    AND intents <@ ARRAY[
      'informational', 'commercial', 'transactional', 'navigational'
    ]::varchar(32)[]
    AND cardinality(array_positions(intents, 'informational')) <= 1
    AND cardinality(array_positions(intents, 'commercial')) <= 1
    AND cardinality(array_positions(intents, 'transactional')) <= 1
    AND cardinality(array_positions(intents, 'navigational')) <= 1
  ),
  CONSTRAINT keyword_import_candidates_synonyms_check
    CHECK (cardinality(synonyms) <= 50 AND is_valid_nonblank_text_array(synonyms)),
  CONSTRAINT keyword_import_candidates_source_intent_check CHECK (
    source_intent IN (
      '价格咨询', '信任筛选', '本地搜索', '品质筛选', '价格筛选', '联系方式',
      '商圈/街道搜索', '即时需求', '路线需求', '时间需求', '比较选择', '预约转化',
      '服务方式', '核心服务', '服务咨询', '预约咨询', '避坑咨询', '时效咨询', '攻略咨询'
    )
  ),
  CONSTRAINT keyword_import_candidates_page_type_check CHECK (
    suggested_page_type IN (
      '服务页', '报价页', '联系页', '对比页', '场景页', '企业服务页', '预约页',
      '问答页', '单项服务页', '车型页'
    )
  ),
  CONSTRAINT keyword_import_candidates_cluster_key_check
    CHECK (cluster_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT keyword_import_candidates_metadata_check CHECK (
    jsonb_typeof(metadata_json) = 'object'
    AND metadata_json->>'schema_version' = 'keyword-import-metadata@1'
  )
);
--> statement-breakpoint
CREATE INDEX keyword_import_candidates_job_row_idx
  ON keyword_import_candidates (tenant_id, import_job_id, row_number);
--> statement-breakpoint
CREATE INDEX keyword_import_candidates_filter_idx
  ON keyword_import_candidates (
    tenant_id, import_job_id, source_intent, suggested_page_type, row_number
  );
--> statement-breakpoint
ALTER TABLE keywords
  ADD COLUMN import_metadata_json jsonb,
  ADD COLUMN source_import_job_id uuid,
  ADD CONSTRAINT keywords_source_import_job_fk
    FOREIGN KEY (source_import_job_id, tenant_id)
    REFERENCES keyword_import_jobs(id, tenant_id) ON DELETE RESTRICT,
  ADD CONSTRAINT keywords_import_metadata_check CHECK (
    (source_import_job_id IS NULL AND import_metadata_json IS NULL)
    OR (
      source_import_job_id IS NOT NULL
      AND jsonb_typeof(import_metadata_json) = 'object'
      AND import_metadata_json->>'schema_version' = 'keyword-import-metadata@1'
    )
  );
