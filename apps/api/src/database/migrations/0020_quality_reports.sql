CREATE TABLE quality_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  generation_run_id uuid NOT NULL,
  checker_version varchar(32) NOT NULL,
  score numeric(5,2) NOT NULL,
  decision varchar(16) NOT NULL,
  issues_json jsonb NOT NULL,
  geo_scores_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quality_reports_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT quality_reports_run_uq UNIQUE (tenant_id, generation_run_id),
  CONSTRAINT quality_reports_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT quality_reports_variant_fk
    FOREIGN KEY (variant_id, tenant_id)
    REFERENCES content_variants(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT quality_reports_content_version_fk
    FOREIGN KEY (content_version_id, tenant_id)
    REFERENCES content_versions(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT quality_reports_generation_run_fk
    FOREIGN KEY (generation_run_id, tenant_id)
    REFERENCES generation_runs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT quality_reports_checker_version_check
    CHECK (
      char_length(btrim(checker_version)) BETWEEN 1 AND 32
      AND checker_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$'
    ),
  CONSTRAINT quality_reports_score_check CHECK (score BETWEEN 0 AND 100),
  CONSTRAINT quality_reports_decision_check CHECK (decision IN ('pass', 'revise', 'block')),
  CONSTRAINT quality_reports_issues_check CHECK (
    COALESCE(
      jsonb_typeof(issues_json) = 'object'
      AND issues_json->>'schema_version' = 'quality-checker-data@1'
      AND issues_json - ARRAY['schema_version', 'issues']::text[] = '{}'::jsonb
      AND jsonb_typeof(issues_json->'issues') = 'array',
      false
    )
  ),
  CONSTRAINT quality_reports_geo_scores_check CHECK (
    COALESCE(
      jsonb_typeof(geo_scores_json) = 'object'
      AND geo_scores_json->>'schema_version' = 'geo-scores@1'
      AND geo_scores_json ?& ARRAY[
        'entity', 'question', 'answerability', 'evidence',
        'platform_fit', 'readability_safety', 'total'
      ]::text[]
      AND geo_scores_json - ARRAY[
        'schema_version', 'entity', 'question', 'answerability', 'evidence',
        'platform_fit', 'readability_safety', 'total'
      ]::text[] = '{}'::jsonb
      AND NOT jsonb_path_exists(
        geo_scores_json,
        '$.* ? (@.type() != "number" && @ != "geo-scores@1")'
      )
      AND (geo_scores_json->>'entity')::numeric BETWEEN 0 AND 100
      AND (geo_scores_json->>'question')::numeric BETWEEN 0 AND 100
      AND (geo_scores_json->>'answerability')::numeric BETWEEN 0 AND 100
      AND (geo_scores_json->>'evidence')::numeric BETWEEN 0 AND 100
      AND (geo_scores_json->>'platform_fit')::numeric BETWEEN 0 AND 100
      AND (geo_scores_json->>'readability_safety')::numeric BETWEEN 0 AND 100
      AND (geo_scores_json->>'total')::numeric BETWEEN 0 AND 100,
      false
    )
  )
);
--> statement-breakpoint
CREATE INDEX quality_reports_variant_created_idx
  ON quality_reports (tenant_id, variant_id, created_at DESC, id);
--> statement-breakpoint
CREATE FUNCTION enforce_quality_report_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM generation_runs AS run
    JOIN content_variants AS variant
      ON variant.id = NEW.variant_id AND variant.tenant_id = NEW.tenant_id
    JOIN content_packages AS package
      ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
    JOIN content_versions AS version
      ON version.id = NEW.content_version_id
      AND version.tenant_id = NEW.tenant_id
      AND version.package_id = package.id
      AND version.variant_id = variant.id
    WHERE
      run.id = NEW.generation_run_id
      AND run.tenant_id = NEW.tenant_id
      AND run.workspace_id = package.workspace_id
      AND run.project_id = package.project_id
      AND run.package_id = package.id
      AND run.variant_id = variant.id
      AND run.skill_name = 'quality-checker'
      AND variant.current_content_version_id = version.id
  ) THEN
    RAISE EXCEPTION 'quality report is outside its run or current content scope';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER quality_reports_scope_guard
  BEFORE INSERT ON quality_reports
  FOR EACH ROW
  EXECUTE FUNCTION enforce_quality_report_scope();
--> statement-breakpoint
CREATE FUNCTION protect_quality_report_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'quality reports are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER quality_reports_append_only_guard
  BEFORE UPDATE OR DELETE ON quality_reports
  FOR EACH ROW
  EXECUTE FUNCTION protect_quality_report_history();
--> statement-breakpoint
COMMENT ON TABLE quality_reports IS
  'Immutable final quality gate reports for the exact current content version.';
