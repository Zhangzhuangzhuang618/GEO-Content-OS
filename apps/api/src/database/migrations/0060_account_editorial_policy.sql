ALTER TABLE platform_accounts ADD CONSTRAINT platform_accounts_editorial_scope_uq
  UNIQUE (id, tenant_id, workspace_id, platform_code);
--> statement-breakpoint
CREATE TABLE platform_account_content_policies (
  account_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  platform_code varchar(24) NOT NULL CHECK (platform_code IN ('official_site','lieju','douyin')),
  default_style varchar(32) NOT NULL DEFAULT 'standard'
    CHECK (default_style IN ('standard','company_recommendation')),
  recommended_companies_json jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(recommended_companies_json)='array' AND jsonb_array_length(recommended_companies_json)<=6),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id,tenant_id,workspace_id,platform_code)
    REFERENCES platform_accounts(id,tenant_id,workspace_id,platform_code) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by) REFERENCES memberships(tenant_id,user_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,updated_by) REFERENCES memberships(tenant_id,user_id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TRIGGER platform_account_content_policies_updated_at BEFORE UPDATE
  ON platform_account_content_policies FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
ALTER TABLE official_site_automation_policies ADD COLUMN content_style_override varchar(32)
  CHECK (content_style_override IN ('standard','company_recommendation'));
--> statement-breakpoint
ALTER TABLE browser_platform_automation_policies ADD COLUMN content_style_override varchar(32),
  ADD CONSTRAINT browser_platform_editorial_style_check CHECK (
    content_style_override IS NULL OR
    (platform_code IN ('lieju','douyin') AND content_style_override IN ('standard','company_recommendation'))
  );
--> statement-breakpoint
ALTER TABLE official_site_daily_batches
  ADD COLUMN requested_content_style varchar(32) CHECK (requested_content_style IN ('standard','company_recommendation')),
  ADD COLUMN editorial_policy_snapshot_json jsonb;
--> statement-breakpoint
ALTER TABLE browser_platform_daily_batches
  ADD COLUMN requested_content_style varchar(32) CHECK (requested_content_style IN ('standard','company_recommendation')),
  ADD COLUMN editorial_policy_snapshot_json jsonb;
--> statement-breakpoint
ALTER TABLE content_versions ADD COLUMN editorial_context_json jsonb
  CHECK (editorial_context_json IS NULL OR COALESCE((
    jsonb_typeof(editorial_context_json)='object'
    AND editorial_context_json->>'schema_version'='editorial-context@1'
    AND editorial_context_json->>'platform_code' IN ('official_site','lieju','douyin')
    AND editorial_context_json->>'style' IN ('standard','company_recommendation')
  ),false));
--> statement-breakpoint
-- Freeze at INSERT, not when a worker eventually reaches the first candidate.
CREATE FUNCTION freeze_daily_editorial_policy() RETURNS trigger LANGUAGE plpgsql AS $$
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
    WHERE account_id=account_scope.account_id AND tenant_id=NEW.tenant_id FOR SHARE;
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
--> statement-breakpoint
CREATE TRIGGER official_site_daily_editorial_snapshot BEFORE INSERT OR UPDATE
  ON official_site_daily_batches FOR EACH ROW EXECUTE FUNCTION freeze_daily_editorial_policy();
--> statement-breakpoint
CREATE TRIGGER browser_platform_daily_editorial_snapshot BEFORE INSERT OR UPDATE
  ON browser_platform_daily_batches FOR EACH ROW EXECUTE FUNCTION freeze_daily_editorial_policy();
