CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  plan_code varchar(32) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'trial',
  period_start date NOT NULL,
  period_end date NOT NULL,
  quota_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT subscriptions_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT subscriptions_plan_code_check
    CHECK (char_length(btrim(plan_code)) BETWEEN 1 AND 32),
  CONSTRAINT subscriptions_status_check
    CHECK (status IN ('trial', 'active', 'past_due', 'cancelled')),
  CONSTRAINT subscriptions_period_check CHECK (period_end >= period_start),
  CONSTRAINT subscriptions_quota_check CHECK (
    COALESCE(
      jsonb_typeof(quota_json) = 'object'
      AND quota_json->>'schema_version' = 'quota@1',
      false
    )
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX subscriptions_tenant_period_uq
  ON subscriptions (tenant_id, period_start, period_end);
--> statement-breakpoint
CREATE INDEX subscriptions_tenant_status_period_idx
  ON subscriptions (tenant_id, status, period_end DESC, id);
--> statement-breakpoint
CREATE TRIGGER subscriptions_set_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE model_rate_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_key varchar(80) NOT NULL,
  provider varchar(80) NOT NULL,
  provider_model_id varchar(160) NOT NULL,
  capabilities_json jsonb NOT NULL,
  input_rate_micros bigint NOT NULL,
  output_rate_micros bigint NOT NULL,
  currency char(3) NOT NULL DEFAULT 'CNY',
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_rate_cards_model_effective_uq UNIQUE (model_key, effective_from),
  CONSTRAINT model_rate_cards_model_key_check
    CHECK (char_length(btrim(model_key)) BETWEEN 1 AND 80),
  CONSTRAINT model_rate_cards_provider_check
    CHECK (char_length(btrim(provider)) BETWEEN 1 AND 80),
  CONSTRAINT model_rate_cards_provider_model_check
    CHECK (char_length(btrim(provider_model_id)) BETWEEN 1 AND 160),
  CONSTRAINT model_rate_cards_capabilities_check CHECK (
    COALESCE(
      jsonb_typeof(capabilities_json) = 'object'
      AND capabilities_json->>'schema_version' = 'model-capability@1',
      false
    )
  ),
  CONSTRAINT model_rate_cards_input_rate_check CHECK (input_rate_micros >= 0),
  CONSTRAINT model_rate_cards_output_rate_check CHECK (output_rate_micros >= 0),
  CONSTRAINT model_rate_cards_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT model_rate_cards_effective_range_check
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);
--> statement-breakpoint
CREATE INDEX model_rate_cards_model_effective_idx
  ON model_rate_cards (model_key, effective_from DESC, effective_to);
--> statement-breakpoint
CREATE FUNCTION protect_model_rate_card_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'model rate cards are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER model_rate_cards_history_guard
  BEFORE UPDATE OR DELETE ON model_rate_cards
  FOR EACH ROW
  EXECUTE FUNCTION protect_model_rate_card_history();
