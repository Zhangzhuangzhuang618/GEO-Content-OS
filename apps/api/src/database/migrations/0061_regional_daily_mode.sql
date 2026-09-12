ALTER TABLE platform_account_content_policies
  ADD COLUMN regional_mode_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN regional_cursor integer NOT NULL DEFAULT 0 CHECK (regional_cursor BETWEEN 0 AND 10);
--> statement-breakpoint
-- A plan is shared by retries of the same account/date; existing batches remain disabled.
CREATE TABLE regional_daily_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  business_date date NOT NULL,
  districts text[] NOT NULL CHECK (cardinality(districts)>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,account_id,business_date),
  UNIQUE (id,tenant_id),
  FOREIGN KEY (account_id,tenant_id) REFERENCES platform_accounts(id,tenant_id) ON DELETE RESTRICT
);
--> statement-breakpoint
ALTER TABLE official_site_daily_batches ADD COLUMN regional_plan_id uuid,
  ADD FOREIGN KEY (regional_plan_id,tenant_id) REFERENCES regional_daily_plans(id,tenant_id);
ALTER TABLE browser_platform_daily_batches ADD COLUMN regional_plan_id uuid,
  ADD FOREIGN KEY (regional_plan_id,tenant_id) REFERENCES regional_daily_plans(id,tenant_id);
ALTER TABLE official_site_daily_batch_items ADD COLUMN regional_slot integer CHECK (regional_slot>0);
ALTER TABLE browser_platform_daily_batch_items ADD COLUMN regional_slot integer CHECK (regional_slot>0);
--> statement-breakpoint
CREATE FUNCTION allocate_regional_daily_plan() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_account uuid;
  target integer;
  setting record;
  plan_id uuid;
  names text[] := ARRAY['越秀','海珠','荔湾','天河','白云','黄埔','番禺','花都','南沙','从化','增城'];
  selected text[];
BEGIN
  IF TG_TABLE_NAME='official_site_daily_batches' THEN
    SELECT account_id,daily_target_count INTO owner_account,target FROM official_site_automation_policies WHERE id=NEW.policy_id AND tenant_id=NEW.tenant_id;
  ELSE
    SELECT account_id,daily_target_count INTO owner_account,target FROM browser_platform_automation_policies
      WHERE id=NEW.policy_id AND tenant_id=NEW.tenant_id AND platform_code IN ('lieju','douyin');
  END IF;
  IF owner_account IS NULL THEN RETURN NULL; END IF;
  SELECT regional_mode_enabled,regional_cursor INTO setting FROM platform_account_content_policies
    WHERE account_id=owner_account AND tenant_id=NEW.tenant_id FOR UPDATE;
  IF NOT FOUND OR NOT setting.regional_mode_enabled THEN RETURN NULL; END IF;
  SELECT id INTO plan_id FROM regional_daily_plans
    WHERE tenant_id=NEW.tenant_id AND account_id=owner_account AND business_date=NEW.business_date;
  IF plan_id IS NULL THEN
    SELECT array_agg(names[1+((setting.regional_cursor+i)%11)] ORDER BY i) INTO selected FROM generate_series(0,target-1) i;
    INSERT INTO regional_daily_plans(tenant_id,account_id,business_date,districts)
      VALUES(NEW.tenant_id,owner_account,NEW.business_date,selected) RETURNING id INTO plan_id;
    UPDATE platform_account_content_policies SET regional_cursor=(setting.regional_cursor+target)%11
      WHERE tenant_id=NEW.tenant_id AND account_id=owner_account;
  END IF;
  EXECUTE format('UPDATE %I SET regional_plan_id=$1 WHERE id=$2 AND tenant_id=$3',TG_TABLE_NAME)
    USING plan_id,NEW.id,NEW.tenant_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- AFTER INSERT avoids advancing the cursor for INSERT ... ON CONFLICT DO NOTHING.
CREATE TRIGGER official_site_regional_plan AFTER INSERT ON official_site_daily_batches
  FOR EACH ROW EXECUTE FUNCTION allocate_regional_daily_plan();
CREATE TRIGGER browser_platform_regional_plan AFTER INSERT ON browser_platform_daily_batches
  FOR EACH ROW EXECUTE FUNCTION allocate_regional_daily_plan();
--> statement-breakpoint
CREATE FUNCTION guard_regional_daily_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'regional daily plans are immutable';
END;
$$;
CREATE TRIGGER regional_daily_plan_immutable BEFORE UPDATE ON regional_daily_plans
  FOR EACH ROW EXECUTE FUNCTION guard_regional_daily_plan();
--> statement-breakpoint
CREATE FUNCTION guard_regional_batch_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_account uuid;
BEGIN
  IF OLD.regional_plan_id IS NOT NULL AND NEW.regional_plan_id IS DISTINCT FROM OLD.regional_plan_id THEN
    RAISE EXCEPTION 'regional batch bindings are immutable';
  END IF;
  IF NEW.regional_plan_id IS NOT NULL THEN
    IF TG_TABLE_NAME='official_site_daily_batches' THEN
      SELECT account_id INTO owner_account FROM official_site_automation_policies WHERE id=NEW.policy_id AND tenant_id=NEW.tenant_id;
    ELSE
      SELECT account_id INTO owner_account FROM browser_platform_automation_policies WHERE id=NEW.policy_id AND tenant_id=NEW.tenant_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM regional_daily_plans WHERE id=NEW.regional_plan_id AND tenant_id=NEW.tenant_id
      AND account_id=owner_account AND business_date=NEW.business_date) THEN
      RAISE EXCEPTION 'regional plan account or date mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER official_site_regional_binding BEFORE UPDATE ON official_site_daily_batches
  FOR EACH ROW EXECUTE FUNCTION guard_regional_batch_binding();
CREATE TRIGGER browser_platform_regional_binding BEFORE UPDATE ON browser_platform_daily_batches
  FOR EACH ROW EXECUTE FUNCTION guard_regional_batch_binding();
--> statement-breakpoint
-- Acquire the policy write lock before snapshotting: two inserts must not both
-- take SHARE locks and then deadlock while advancing the regional cursor.
CREATE OR REPLACE FUNCTION freeze_daily_editorial_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  account_scope record;
  settings record;
  selected_style text;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.editorial_policy_snapshot_json IS DISTINCT FROM OLD.editorial_policy_snapshot_json
      OR NEW.requested_content_style IS DISTINCT FROM OLD.requested_content_style THEN
      RAISE EXCEPTION 'daily editorial policy snapshots are immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='official_site_daily_batches' THEN
    SELECT account_id,tenant_id,'official_site'::text AS platform_code,content_style_override
      INTO account_scope FROM official_site_automation_policies
      WHERE id=NEW.policy_id AND tenant_id=NEW.tenant_id FOR SHARE;
  ELSE
    SELECT account_id,tenant_id,platform_code,content_style_override
      INTO account_scope FROM browser_platform_automation_policies
      WHERE id=NEW.policy_id AND tenant_id=NEW.tenant_id FOR SHARE;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'daily editorial policy scope not found'; END IF;
  IF account_scope.platform_code NOT IN ('official_site','lieju','douyin') THEN
    IF NEW.requested_content_style IS NOT NULL THEN RAISE EXCEPTION 'editorial style not supported'; END IF;
    NEW.editorial_policy_snapshot_json := NULL;
    RETURN NEW;
  END IF;
  SELECT default_style,recommended_companies_json,version INTO settings
    FROM platform_account_content_policies
    WHERE account_id=account_scope.account_id AND tenant_id=NEW.tenant_id FOR UPDATE;
  selected_style := COALESCE(NEW.requested_content_style,account_scope.content_style_override,settings.default_style,'standard');
  NEW.editorial_policy_snapshot_json := jsonb_build_object(
    'schema_version','editorial-context@1','template_version','company-recommendation@1',
    'account_id',account_scope.account_id,'platform_code',account_scope.platform_code,
    'policy_version',COALESCE(settings.version,0),'style',selected_style,
    'companies',CASE WHEN selected_style='company_recommendation'
      THEN COALESCE(settings.recommended_companies_json,'[]'::jsonb) ELSE '[]'::jsonb END
  );
  RETURN NEW;
END;
$$;
