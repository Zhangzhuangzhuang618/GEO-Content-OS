ALTER TABLE browser_platform_automation_policies
  ADD COLUMN account_positioning varchar(240) NOT NULL DEFAULT '',
  ADD COLUMN service_scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN target_regions text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN topic_pool text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD CONSTRAINT browser_platform_automation_policies_douyin_strategy_check CHECK (
    (
      platform_code = 'douyin'
      AND (
        (
          btrim(account_positioning) = ''
          AND cardinality(service_scopes) = 0
          AND cardinality(target_regions) = 0
          AND cardinality(topic_pool) = 0
        ) OR (
          char_length(btrim(account_positioning)) BETWEEN 1 AND 240
          AND cardinality(service_scopes) BETWEEN 1 AND 12
          AND cardinality(target_regions) BETWEEN 1 AND 12
          AND cardinality(topic_pool) BETWEEN 1 AND 30
        )
      )
    ) OR (
      platform_code <> 'douyin'
      AND btrim(account_positioning) = ''
      AND cardinality(service_scopes) = 0
      AND cardinality(target_regions) = 0
      AND cardinality(topic_pool) = 0
    )
  ),
  ADD CONSTRAINT browser_platform_automation_policies_service_scopes_check CHECK (
    cardinality(service_scopes) <= 12 AND is_valid_nonblank_text_array(service_scopes)
  ),
  ADD CONSTRAINT browser_platform_automation_policies_target_regions_check CHECK (
    cardinality(target_regions) <= 12 AND is_valid_nonblank_text_array(target_regions)
  ),
  ADD CONSTRAINT browser_platform_automation_policies_topic_pool_check CHECK (
    cardinality(topic_pool) <= 30 AND is_valid_nonblank_text_array(topic_pool)
  );
--> statement-breakpoint
CREATE TABLE douyin_topic_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  account_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  business_date date NOT NULL,
  keyword_term citext NOT NULL,
  search_intent varchar(32) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT douyin_topic_reservations_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT douyin_topic_reservations_company_topic_uq UNIQUE (
    tenant_id, workspace_id, business_date, keyword_term, search_intent
  ),
  CONSTRAINT douyin_topic_reservations_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT douyin_topic_reservations_workspace_fk
    FOREIGN KEY (workspace_id, tenant_id)
    REFERENCES workspaces(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT douyin_topic_reservations_policy_fk
    FOREIGN KEY (policy_id, tenant_id)
    REFERENCES browser_platform_automation_policies(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT douyin_topic_reservations_account_fk
    FOREIGN KEY (account_id, tenant_id)
    REFERENCES platform_accounts(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT douyin_topic_reservations_batch_fk
    FOREIGN KEY (batch_id, tenant_id)
    REFERENCES browser_platform_daily_batches(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT douyin_topic_reservations_keyword_check CHECK (
    char_length(btrim(keyword_term::text)) BETWEEN 1 AND 240
  ),
  CONSTRAINT douyin_topic_reservations_intent_check CHECK (
    search_intent IN (
      'recommendation','comparison','pricing','legitimacy','contract','liability',
      'vehicle','labor','access','risk_avoidance','scheduling','acceptance'
    )
  )
);
--> statement-breakpoint
CREATE INDEX douyin_topic_reservations_account_date_idx
  ON douyin_topic_reservations (tenant_id, account_id, business_date, created_at, id);
--> statement-breakpoint
CREATE FUNCTION enforce_douyin_topic_reservation_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM browser_platform_automation_policies AS policy
    JOIN browser_platform_daily_batches AS batch
      ON batch.id = NEW.batch_id AND batch.tenant_id = NEW.tenant_id
      AND batch.policy_id = policy.id AND batch.business_date = NEW.business_date
    JOIN platform_accounts AS account
      ON account.id = NEW.account_id AND account.tenant_id = NEW.tenant_id
      AND account.workspace_id = NEW.workspace_id AND account.platform_code = 'douyin'
      AND account.deleted_at IS NULL
    WHERE policy.id = NEW.policy_id AND policy.tenant_id = NEW.tenant_id
      AND policy.workspace_id = NEW.workspace_id AND policy.account_id = NEW.account_id
      AND policy.platform_code = 'douyin'
  ) THEN
    RAISE EXCEPTION 'douyin topic reservation scope is invalid';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER douyin_topic_reservations_scope_guard
  BEFORE INSERT OR UPDATE OF
    tenant_id, workspace_id, policy_id, account_id, batch_id, business_date
  ON douyin_topic_reservations
  FOR EACH ROW EXECUTE FUNCTION enforce_douyin_topic_reservation_scope();
