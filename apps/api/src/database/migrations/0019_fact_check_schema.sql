CREATE TABLE fact_check_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  generation_run_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  fact_id uuid,
  claim_key varchar(80) NOT NULL,
  claim_text text NOT NULL,
  claim_hash char(64) NOT NULL,
  verdict varchar(24) NOT NULL,
  risk_level varchar(16) NOT NULL,
  confidence numeric(5,4) NOT NULL,
  reason text NOT NULL,
  rewrite_suggestion text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fact_check_results_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT fact_check_results_run_claim_uq
    UNIQUE (tenant_id, generation_run_id, variant_id, claim_hash),
  CONSTRAINT fact_check_results_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT fact_check_results_run_fk
    FOREIGN KEY (generation_run_id, tenant_id)
    REFERENCES generation_runs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fact_check_results_variant_fk
    FOREIGN KEY (variant_id, tenant_id)
    REFERENCES content_variants(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fact_check_results_fact_fk
    FOREIGN KEY (fact_id, tenant_id)
    REFERENCES facts(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fact_check_results_claim_key_check
    CHECK (char_length(btrim(claim_key)) BETWEEN 1 AND 80),
  CONSTRAINT fact_check_results_claim_text_check
    CHECK (char_length(btrim(claim_text)) BETWEEN 1 AND 10000),
  CONSTRAINT fact_check_results_claim_hash_check
    CHECK (claim_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT fact_check_results_verdict_check
    CHECK (verdict IN (
      'supported', 'partially_supported', 'conflicted', 'unsupported', 'outdated'
    )),
  CONSTRAINT fact_check_results_risk_level_check
    CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT fact_check_results_confidence_check CHECK (confidence BETWEEN 0 AND 1),
  CONSTRAINT fact_check_results_reason_check
    CHECK (char_length(btrim(reason)) BETWEEN 1 AND 4000),
  CONSTRAINT fact_check_results_rewrite_check
    CHECK (
      rewrite_suggestion IS NULL
      OR char_length(btrim(rewrite_suggestion)) BETWEEN 1 AND 10000
    )
);
--> statement-breakpoint
CREATE INDEX fact_check_results_variant_created_idx
  ON fact_check_results (tenant_id, variant_id, created_at DESC, id);
--> statement-breakpoint
CREATE FUNCTION enforce_fact_check_result_scope()
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
    WHERE
      run.id = NEW.generation_run_id
      AND run.tenant_id = NEW.tenant_id
      AND run.workspace_id = package.workspace_id
      AND run.project_id = package.project_id
      AND run.package_id = package.id
      AND run.variant_id = variant.id
      AND run.skill_name = 'fact-checker'
      AND (
        NEW.fact_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM facts AS fact
          WHERE
            fact.id = NEW.fact_id
            AND fact.tenant_id = NEW.tenant_id
            AND fact.workspace_id = run.workspace_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'fact check result is outside its generation run scope';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER fact_check_results_scope_guard
  BEFORE INSERT ON fact_check_results
  FOR EACH ROW
  EXECUTE FUNCTION enforce_fact_check_result_scope();
--> statement-breakpoint
CREATE TABLE fact_evidences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  fact_check_result_id uuid NOT NULL,
  fact_id uuid,
  chunk_id uuid NOT NULL,
  quote_text text NOT NULL,
  quote_hash char(64) NOT NULL,
  support_level varchar(24) NOT NULL,
  confidence numeric(5,4) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fact_evidences_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT fact_evidences_result_chunk_quote_uq
    UNIQUE (tenant_id, fact_check_result_id, chunk_id, quote_hash),
  CONSTRAINT fact_evidences_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT fact_evidences_result_fk
    FOREIGN KEY (fact_check_result_id, tenant_id)
    REFERENCES fact_check_results(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT fact_evidences_fact_fk
    FOREIGN KEY (fact_id, tenant_id)
    REFERENCES facts(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fact_evidences_chunk_fk
    FOREIGN KEY (chunk_id, tenant_id)
    REFERENCES source_chunks(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fact_evidences_quote_text_check
    CHECK (char_length(btrim(quote_text)) BETWEEN 1 AND 10000),
  CONSTRAINT fact_evidences_quote_hash_check
    CHECK (quote_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT fact_evidences_support_level_check
    CHECK (support_level IN (
      'supported', 'partially_supported', 'conflicted', 'outdated'
    )),
  CONSTRAINT fact_evidences_confidence_check CHECK (confidence BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE INDEX fact_evidences_chunk_idx
  ON fact_evidences (tenant_id, chunk_id, fact_check_result_id);
--> statement-breakpoint
CREATE FUNCTION enforce_fact_evidence_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_text text;
  result_verdict varchar(24);
BEGIN
  SELECT chunk.text, result.verdict
  INTO source_text, result_verdict
  FROM fact_check_results AS result
  JOIN generation_runs AS run
    ON run.id = result.generation_run_id AND run.tenant_id = result.tenant_id
  JOIN source_chunks AS chunk
    ON chunk.id = NEW.chunk_id AND chunk.tenant_id = NEW.tenant_id
  JOIN source_documents AS source
    ON source.id = chunk.source_document_id AND source.tenant_id = chunk.tenant_id
  WHERE
    result.id = NEW.fact_check_result_id
    AND result.tenant_id = NEW.tenant_id
    AND source.workspace_id = run.workspace_id
    AND (source.project_id IS NULL OR source.project_id = run.project_id)
    AND source.deleted_at IS NULL
    AND source.status = 'active'
    AND source.trust_level <> 'untrusted'
    AND (source.effective_from IS NULL OR source.effective_from <= CURRENT_DATE)
    AND (source.effective_to IS NULL OR source.effective_to >= CURRENT_DATE)
    AND chunk.status = 'active'
    AND (
      NEW.fact_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM facts AS fact
        WHERE
          fact.id = NEW.fact_id
          AND fact.tenant_id = NEW.tenant_id
          AND fact.workspace_id = run.workspace_id
      )
    );

  IF source_text IS NULL OR result_verdict = 'unsupported' THEN
    RAISE EXCEPTION 'fact evidence is not eligible for this result';
  END IF;
  IF strpos(source_text, NEW.quote_text) = 0 THEN
    RAISE EXCEPTION 'fact evidence quote must be a continuous source chunk substring';
  END IF;
  IF encode(digest(convert_to(NEW.quote_text, 'UTF8'), 'sha256'), 'hex') <> NEW.quote_hash THEN
    RAISE EXCEPTION 'fact evidence quote hash does not match quote text';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER fact_evidences_provenance_guard
  BEFORE INSERT ON fact_evidences
  FOR EACH ROW
  EXECUTE FUNCTION enforce_fact_evidence_provenance();
--> statement-breakpoint
CREATE FUNCTION enforce_fact_check_evidence_cardinality()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.verdict <> 'unsupported' AND NOT EXISTS (
    SELECT 1
    FROM fact_evidences AS evidence
    WHERE
      evidence.tenant_id = NEW.tenant_id
      AND evidence.fact_check_result_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'non-unsupported fact check result requires evidence';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER fact_check_results_evidence_required
  AFTER INSERT ON fact_check_results
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION enforce_fact_check_evidence_cardinality();
--> statement-breakpoint
CREATE FUNCTION protect_fact_check_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'fact check history is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER fact_check_results_append_only_guard
  BEFORE UPDATE OR DELETE ON fact_check_results
  FOR EACH ROW
  EXECUTE FUNCTION protect_fact_check_history();
--> statement-breakpoint
CREATE TRIGGER fact_evidences_append_only_guard
  BEFORE UPDATE OR DELETE ON fact_evidences
  FOR EACH ROW
  EXECUTE FUNCTION protect_fact_check_history();
--> statement-breakpoint
COMMENT ON TABLE fact_check_results IS
  'Immutable, run-idempotent claim verdicts; claim_hash is computed by the server.';
--> statement-breakpoint
COMMENT ON TABLE fact_evidences IS
  'Immutable source evidence for non-unsupported fact-check verdicts.';
