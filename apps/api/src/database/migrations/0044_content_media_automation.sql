CREATE TABLE content_media_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  package_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  quality_report_id uuid NOT NULL,
  platform_code varchar(24) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'queued',
  planner_model_key varchar(80) NOT NULL,
  provider varchar(80),
  generation_model varchar(160),
  inspection_model varchar(160),
  plan_json jsonb,
  diagnostics_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error_json jsonb,
  created_by uuid NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_media_runs_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT content_media_runs_report_uq UNIQUE (tenant_id, quality_report_id),
  CONSTRAINT content_media_runs_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT content_media_runs_package_fk
    FOREIGN KEY (package_id, tenant_id, workspace_id, project_id)
    REFERENCES content_packages(id, tenant_id, workspace_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT content_media_runs_variant_fk
    FOREIGN KEY (variant_id, tenant_id, package_id)
    REFERENCES content_variants(id, tenant_id, package_id) ON DELETE RESTRICT,
  CONSTRAINT content_media_runs_version_fk
    FOREIGN KEY (content_version_id, tenant_id, package_id, variant_id)
    REFERENCES content_versions(id, tenant_id, package_id, variant_id) ON DELETE RESTRICT,
  CONSTRAINT content_media_runs_report_fk
    FOREIGN KEY (quality_report_id, tenant_id)
    REFERENCES quality_reports(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT content_media_runs_created_by_fk
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT content_media_runs_created_by_membership_fk
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT content_media_runs_platform_check
    CHECK (platform_code IN ('official_site', 'baijiahao')),
  CONSTRAINT content_media_runs_status_check CHECK (
    status IN ('queued', 'running', 'succeeded', 'fallback', 'cancelled')
  ),
  CONSTRAINT content_media_runs_provider_check CHECK (
    provider IS NULL OR char_length(btrim(provider)) BETWEEN 1 AND 80
  ),
  CONSTRAINT content_media_runs_model_check CHECK (
    char_length(btrim(planner_model_key)) BETWEEN 1 AND 80
    AND (generation_model IS NULL OR char_length(btrim(generation_model)) BETWEEN 1 AND 160)
    AND (inspection_model IS NULL OR char_length(btrim(inspection_model)) BETWEEN 1 AND 160)
  ),
  CONSTRAINT content_media_runs_plan_check CHECK (
    plan_json IS NULL OR jsonb_typeof(plan_json) = 'object'
  ),
  CONSTRAINT content_media_runs_diagnostics_check CHECK (
    jsonb_typeof(diagnostics_json) = 'object'
  ),
  CONSTRAINT content_media_runs_error_check CHECK (
    last_error_json IS NULL OR jsonb_typeof(last_error_json) = 'object'
  ),
  CONSTRAINT content_media_runs_version_check CHECK (version > 0),
  CONSTRAINT content_media_runs_time_check CHECK (
    (status = 'queued' AND started_at IS NULL AND finished_at IS NULL)
    OR (status = 'running' AND started_at IS NOT NULL AND finished_at IS NULL)
    OR (status IN ('succeeded', 'fallback', 'cancelled') AND finished_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX content_media_runs_status_idx
  ON content_media_runs (status, updated_at, id)
  WHERE status IN ('queued', 'running');
--> statement-breakpoint
CREATE INDEX content_media_runs_variant_idx
  ON content_media_runs (tenant_id, variant_id, created_at DESC, id);
--> statement-breakpoint
CREATE TRIGGER content_media_runs_set_updated_at
  BEFORE UPDATE ON content_media_runs
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE FUNCTION enforce_content_media_run_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM quality_reports AS report
    JOIN content_variants AS variant
      ON variant.id = NEW.variant_id AND variant.tenant_id = NEW.tenant_id
      AND variant.package_id = NEW.package_id
    WHERE report.id = NEW.quality_report_id
      AND report.tenant_id = NEW.tenant_id
      AND report.variant_id = NEW.variant_id
      AND report.content_version_id = NEW.content_version_id
      AND variant.platform_code = NEW.platform_code
  ) THEN
    RAISE EXCEPTION 'content media run scope does not match its quality report';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER content_media_runs_scope_guard
  BEFORE INSERT OR UPDATE OF tenant_id, package_id, variant_id, content_version_id,
    quality_report_id, platform_code
  ON content_media_runs
  FOR EACH ROW
  EXECUTE FUNCTION enforce_content_media_run_scope();
--> statement-breakpoint
CREATE TABLE content_media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  content_media_run_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  media_asset_id uuid NOT NULL,
  role varchar(16) NOT NULL,
  position smallint NOT NULL,
  alt_text varchar(240) NOT NULL,
  source varchar(24) NOT NULL,
  public_url text,
  quality_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_media_assets_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT content_media_assets_slot_uq
    UNIQUE (tenant_id, content_version_id, role, position),
  CONSTRAINT content_media_assets_asset_uq UNIQUE (tenant_id, media_asset_id),
  CONSTRAINT content_media_assets_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT content_media_assets_run_fk
    FOREIGN KEY (content_media_run_id, tenant_id)
    REFERENCES content_media_runs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT content_media_assets_version_fk
    FOREIGN KEY (content_version_id, tenant_id)
    REFERENCES content_versions(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT content_media_assets_asset_fk
    FOREIGN KEY (media_asset_id, tenant_id)
    REFERENCES media_assets(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT content_media_assets_role_check CHECK (role IN ('cover', 'body')),
  CONSTRAINT content_media_assets_position_check CHECK (position BETWEEN 0 AND 10),
  CONSTRAINT content_media_assets_alt_check
    CHECK (char_length(btrim(alt_text)) BETWEEN 1 AND 240),
  CONSTRAINT content_media_assets_source_check
    CHECK (source IN ('cloudflare', 'template')),
  CONSTRAINT content_media_assets_public_url_check CHECK (
    public_url IS NULL OR public_url ~* '^https?://'
  ),
  CONSTRAINT content_media_assets_quality_check CHECK (
    jsonb_typeof(quality_json) = 'object'
    AND quality_json->>'schema_version' = 'content-image-quality@1'
    AND quality_json->>'decision' = 'pass'
  )
);
--> statement-breakpoint
CREATE INDEX content_media_assets_version_idx
  ON content_media_assets (tenant_id, content_version_id, role, position, id);
--> statement-breakpoint
CREATE FUNCTION enforce_content_media_asset_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM content_media_runs AS run
    JOIN media_assets AS asset
      ON asset.id = NEW.media_asset_id AND asset.tenant_id = NEW.tenant_id
      AND asset.asset_type = 'image' AND asset.deleted_at IS NULL
    WHERE run.id = NEW.content_media_run_id
      AND run.tenant_id = NEW.tenant_id
      AND run.content_version_id = NEW.content_version_id
      AND asset.workspace_id = run.workspace_id
      AND asset.project_id = run.project_id
      AND asset.metadata_json->>'content_version_id' = NEW.content_version_id::text
      AND asset.metadata_json->>'promotional_watermark' = 'false'
  ) THEN
    RAISE EXCEPTION 'content media asset does not match its run and content version';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER content_media_assets_scope_guard
  BEFORE INSERT ON content_media_assets
  FOR EACH ROW
  EXECUTE FUNCTION enforce_content_media_asset_scope();
--> statement-breakpoint
CREATE FUNCTION protect_content_media_asset_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'content media asset links are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER content_media_assets_append_only_guard
  BEFORE UPDATE OR DELETE ON content_media_assets
  FOR EACH ROW
  EXECUTE FUNCTION protect_content_media_asset_history();
--> statement-breakpoint
ALTER TABLE official_site_automation_runs
  DROP CONSTRAINT official_site_automation_runs_status_check,
  ADD CONSTRAINT official_site_automation_runs_status_check CHECK (
    status IN (
      'quality_pending', 'rewrite_pending', 'rewriting', 'media_pending', 'publish_pending',
      'publishing', 'published', 'manual_required', 'publish_failed', 'disabled'
    )
  );
--> statement-breakpoint
ALTER TABLE official_site_daily_batch_items
  DROP CONSTRAINT official_site_daily_batch_items_status_check,
  ADD CONSTRAINT official_site_daily_batch_items_status_check CHECK (
    status IN (
      'generating', 'quality_check', 'rewriting', 'media_pending', 'qualified',
      'scheduled', 'published', 'publish_failed', 'reserve', 'retired'
    )
  );
--> statement-breakpoint
ALTER TABLE baijiahao_automation_runs
  DROP CONSTRAINT baijiahao_automation_runs_status_check,
  ADD CONSTRAINT baijiahao_automation_runs_status_check CHECK (
    status IN (
      'generation_pending', 'generating', 'adaptation_pending', 'adapting',
      'quality_pending', 'rewrite_pending', 'rewriting', 'media_pending',
      'publish_pending', 'scheduled', 'publishing', 'processing', 'published',
      'skipped', 'manual_required', 'publish_failed', 'disabled'
    )
  );
--> statement-breakpoint
ALTER TABLE baijiahao_daily_batch_items
  DROP CONSTRAINT baijiahao_daily_batch_items_status_check,
  ADD CONSTRAINT baijiahao_daily_batch_items_status_check CHECK (
    status IN (
      'pending', 'adapting', 'generating', 'quality_check', 'rewriting',
      'media_pending', 'qualified', 'scheduled', 'processing', 'published',
      'publish_failed', 'skipped', 'manual_required', 'reserve', 'retired'
    )
  );
