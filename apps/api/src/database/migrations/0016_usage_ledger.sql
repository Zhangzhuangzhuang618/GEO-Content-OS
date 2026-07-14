CREATE TABLE usage_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid,
  project_id uuid,
  package_id uuid,
  variant_id uuid,
  generation_run_id uuid,
  request_id varchar(80) NOT NULL,
  cost_category varchar(32) NOT NULL,
  provider varchar(80),
  model_key varchar(80),
  skill_name varchar(80),
  quantity numeric(18,6) NOT NULL,
  unit varchar(24) NOT NULL,
  input_tokens integer,
  output_tokens integer,
  cost_cents integer NOT NULL,
  currency char(3) NOT NULL DEFAULT 'CNY',
  status varchar(16) NOT NULL,
  reverses_ledger_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_ledger_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT usage_ledger_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT usage_ledger_workspace_fk
    FOREIGN KEY (workspace_id, tenant_id)
    REFERENCES workspaces(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT usage_ledger_project_fk
    FOREIGN KEY (project_id, tenant_id, workspace_id)
    REFERENCES projects(id, tenant_id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT usage_ledger_package_fk
    FOREIGN KEY (package_id, tenant_id, workspace_id, project_id)
    REFERENCES content_packages(id, tenant_id, workspace_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT usage_ledger_variant_fk
    FOREIGN KEY (variant_id, tenant_id, package_id)
    REFERENCES content_variants(id, tenant_id, package_id) ON DELETE RESTRICT,
  CONSTRAINT usage_ledger_generation_run_fk
    FOREIGN KEY (generation_run_id, tenant_id)
    REFERENCES generation_runs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT usage_ledger_reversal_fk
    FOREIGN KEY (reverses_ledger_id, tenant_id)
    REFERENCES usage_ledger(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT usage_ledger_request_check
    CHECK (char_length(btrim(request_id)) BETWEEN 1 AND 80),
  CONSTRAINT usage_ledger_category_check CHECK (
    cost_category IN (
      'llm', 'embedding', 'rerank', 'ocr', 'storage', 'queue',
      'platform_api', 'manual_adjustment'
    )
  ),
  CONSTRAINT usage_ledger_provider_check
    CHECK (provider IS NULL OR char_length(btrim(provider)) BETWEEN 1 AND 80),
  CONSTRAINT usage_ledger_model_check
    CHECK (model_key IS NULL OR char_length(btrim(model_key)) BETWEEN 1 AND 80),
  CONSTRAINT usage_ledger_skill_check
    CHECK (skill_name IS NULL OR char_length(btrim(skill_name)) BETWEEN 1 AND 80),
  CONSTRAINT usage_ledger_quantity_check CHECK (quantity >= 0),
  CONSTRAINT usage_ledger_unit_check
    CHECK (unit IN ('token', 'image', 'page', 'gb_month', 'cpu_second', 'request')),
  CONSTRAINT usage_ledger_input_tokens_check CHECK (input_tokens IS NULL OR input_tokens >= 0),
  CONSTRAINT usage_ledger_output_tokens_check CHECK (output_tokens IS NULL OR output_tokens >= 0),
  CONSTRAINT usage_ledger_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT usage_ledger_status_check CHECK (status IN ('estimated', 'settled', 'reversed')),
  CONSTRAINT usage_ledger_cost_status_check CHECK (
    (status IN ('estimated', 'settled') AND cost_cents >= 0 AND reverses_ledger_id IS NULL)
    OR (status = 'reversed' AND cost_cents <= 0 AND reverses_ledger_id IS NOT NULL)
  ),
  CONSTRAINT usage_ledger_scope_hierarchy_check CHECK (
    (project_id IS NULL OR workspace_id IS NOT NULL)
    AND (package_id IS NULL OR (workspace_id IS NOT NULL AND project_id IS NOT NULL))
    AND (variant_id IS NULL OR package_id IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX usage_ledger_estimate_request_uq
  ON usage_ledger (tenant_id, request_id, cost_category)
  WHERE status = 'estimated';
--> statement-breakpoint
CREATE UNIQUE INDEX usage_ledger_settlement_request_uq
  ON usage_ledger (tenant_id, request_id, cost_category)
  WHERE status = 'settled';
--> statement-breakpoint
CREATE UNIQUE INDEX usage_ledger_one_reversal_uq
  ON usage_ledger (tenant_id, reverses_ledger_id)
  WHERE status = 'reversed';
--> statement-breakpoint
CREATE INDEX usage_ledger_request_idx
  ON usage_ledger (tenant_id, request_id, created_at, id);
--> statement-breakpoint
CREATE INDEX usage_ledger_scope_time_idx
  ON usage_ledger (
    tenant_id, workspace_id, project_id, package_id, variant_id,
    generation_run_id, created_at DESC, id DESC
  );
--> statement-breakpoint
CREATE FUNCTION enforce_usage_ledger_attribution()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_workspace_id uuid;
  run_project_id uuid;
  run_package_id uuid;
  run_variant_id uuid;
BEGIN
  IF NEW.generation_run_id IS NOT NULL THEN
    SELECT workspace_id, project_id, package_id, variant_id
    INTO run_workspace_id, run_project_id, run_package_id, run_variant_id
    FROM generation_runs
    WHERE id = NEW.generation_run_id AND tenant_id = NEW.tenant_id;

    IF NOT FOUND
      OR NEW.workspace_id IS DISTINCT FROM run_workspace_id
      OR NEW.project_id IS DISTINCT FROM run_project_id
      OR NEW.package_id IS DISTINCT FROM run_package_id
      OR NEW.variant_id IS DISTINCT FROM run_variant_id
    THEN
      RAISE EXCEPTION 'usage ledger attribution does not match generation run scope';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER usage_ledger_attribution_guard
  BEFORE INSERT ON usage_ledger
  FOR EACH ROW
  EXECUTE FUNCTION enforce_usage_ledger_attribution();
--> statement-breakpoint
CREATE FUNCTION enforce_usage_ledger_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target usage_ledger%ROWTYPE;
BEGIN
  IF NEW.status = 'settled' AND NOT EXISTS (
    SELECT 1
    FROM usage_ledger AS estimate
    WHERE estimate.tenant_id = NEW.tenant_id
      AND estimate.request_id = NEW.request_id
      AND estimate.cost_category = NEW.cost_category
      AND estimate.status = 'estimated'
      AND estimate.currency = NEW.currency
      AND estimate.workspace_id IS NOT DISTINCT FROM NEW.workspace_id
      AND estimate.project_id IS NOT DISTINCT FROM NEW.project_id
      AND estimate.package_id IS NOT DISTINCT FROM NEW.package_id
      AND estimate.variant_id IS NOT DISTINCT FROM NEW.variant_id
      AND estimate.generation_run_id IS NOT DISTINCT FROM NEW.generation_run_id
      AND estimate.provider IS NOT DISTINCT FROM NEW.provider
      AND estimate.model_key IS NOT DISTINCT FROM NEW.model_key
      AND estimate.skill_name IS NOT DISTINCT FROM NEW.skill_name
      AND estimate.unit = NEW.unit
      AND NOT EXISTS (
        SELECT 1
        FROM usage_ledger AS estimate_reversal
        WHERE estimate_reversal.tenant_id = estimate.tenant_id
          AND estimate_reversal.reverses_ledger_id = estimate.id
          AND estimate_reversal.status = 'reversed'
      )
  ) THEN
    RAISE EXCEPTION 'settled usage requires a matching estimate';
  END IF;

  IF NEW.status = 'reversed' THEN
    SELECT * INTO target
    FROM usage_ledger
    WHERE id = NEW.reverses_ledger_id AND tenant_id = NEW.tenant_id;

    IF NOT FOUND
      OR target.status NOT IN ('estimated', 'settled')
      OR NEW.cost_cents <> -target.cost_cents
      OR NEW.currency <> target.currency
      OR NEW.cost_category <> target.cost_category
      OR NEW.workspace_id IS DISTINCT FROM target.workspace_id
      OR NEW.project_id IS DISTINCT FROM target.project_id
      OR NEW.package_id IS DISTINCT FROM target.package_id
      OR NEW.variant_id IS DISTINCT FROM target.variant_id
      OR NEW.generation_run_id IS DISTINCT FROM target.generation_run_id
      OR NEW.provider IS DISTINCT FROM target.provider
      OR NEW.model_key IS DISTINCT FROM target.model_key
      OR NEW.skill_name IS DISTINCT FROM target.skill_name
      OR NEW.quantity <> target.quantity
      OR NEW.unit <> target.unit
      OR NEW.input_tokens IS DISTINCT FROM target.input_tokens
      OR NEW.output_tokens IS DISTINCT FROM target.output_tokens
      OR (
        target.status = 'estimated'
        AND EXISTS (
          SELECT 1
          FROM usage_ledger AS settlement
          WHERE settlement.tenant_id = target.tenant_id
            AND settlement.request_id = target.request_id
            AND settlement.cost_category = target.cost_category
            AND settlement.status = 'settled'
        )
      )
    THEN
      RAISE EXCEPTION 'usage reversal does not exactly match its target';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER usage_ledger_lifecycle_guard
  BEFORE INSERT ON usage_ledger
  FOR EACH ROW
  EXECUTE FUNCTION enforce_usage_ledger_lifecycle();
--> statement-breakpoint
CREATE FUNCTION protect_usage_ledger_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'usage ledger is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER usage_ledger_append_only_guard
  BEFORE UPDATE OR DELETE ON usage_ledger
  FOR EACH ROW
  EXECUTE FUNCTION protect_usage_ledger_history();
