ALTER TABLE official_site_automation_policies
  ADD COLUMN daily_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN daily_target_count smallint NOT NULL DEFAULT 10,
  ADD COLUMN daily_candidate_limit smallint NOT NULL DEFAULT 30,
  ADD COLUMN daily_generation_time time NOT NULL DEFAULT TIME '00:00',
  ADD COLUMN daily_timezone varchar(64) NOT NULL DEFAULT 'Asia/Shanghai',
  ADD COLUMN daily_schedule_times time[] NOT NULL DEFAULT ARRAY[
    TIME '08:00', TIME '09:30', TIME '11:00', TIME '12:30', TIME '14:00',
    TIME '15:30', TIME '17:00', TIME '18:30', TIME '20:00', TIME '21:30'
  ];
--> statement-breakpoint
ALTER TABLE official_site_automation_policies
  ADD CONSTRAINT official_site_automation_policies_daily_fixed_check CHECK (
    daily_target_count = 10
    AND daily_candidate_limit = 30
    AND daily_generation_time = TIME '00:00'
    AND daily_timezone = 'Asia/Shanghai'
    AND daily_schedule_times = ARRAY[
      TIME '08:00', TIME '09:30', TIME '11:00', TIME '12:30', TIME '14:00',
      TIME '15:30', TIME '17:00', TIME '18:30', TIME '20:00', TIME '21:30'
    ]::time[]
    AND (NOT daily_enabled OR enabled)
  );
--> statement-breakpoint
CREATE TABLE official_site_daily_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  business_date date NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'running',
  last_error_json jsonb,
  version integer NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL DEFAULT now(),
  scheduled_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT official_site_daily_batches_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT official_site_daily_batches_policy_date_uq
    UNIQUE (tenant_id, policy_id, business_date),
  CONSTRAINT official_site_daily_batches_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT official_site_daily_batches_policy_fk
    FOREIGN KEY (policy_id, tenant_id)
    REFERENCES official_site_automation_policies(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT official_site_daily_batches_status_check CHECK (
    status IN ('running', 'scheduled', 'completed', 'attention_required', 'cancelled')
  ),
  CONSTRAINT official_site_daily_batches_error_check CHECK (
    last_error_json IS NULL OR jsonb_typeof(last_error_json) = 'object'
  ),
  CONSTRAINT official_site_daily_batches_version_check CHECK (version > 0),
  CONSTRAINT official_site_daily_batches_terminal_time_check CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX official_site_daily_batches_status_idx
  ON official_site_daily_batches (status, business_date, updated_at, id)
  WHERE status IN ('running', 'scheduled');
--> statement-breakpoint
CREATE TRIGGER official_site_daily_batches_set_updated_at
  BEFORE UPDATE ON official_site_daily_batches
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE official_site_daily_batch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  candidate_no smallint NOT NULL,
  angle_key varchar(80) NOT NULL,
  title varchar(240) NOT NULL,
  brief_id uuid NOT NULL,
  package_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  content_version_id uuid,
  publish_job_id uuid,
  status varchar(24) NOT NULL DEFAULT 'generating',
  scheduled_at timestamptz,
  last_error_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  qualified_at timestamptz,
  published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT official_site_daily_batch_items_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT official_site_daily_batch_items_candidate_uq
    UNIQUE (tenant_id, batch_id, candidate_no),
  CONSTRAINT official_site_daily_batch_items_package_uq UNIQUE (tenant_id, package_id),
  CONSTRAINT official_site_daily_batch_items_variant_uq UNIQUE (tenant_id, variant_id),
  CONSTRAINT official_site_daily_batch_items_publish_job_uq UNIQUE (tenant_id, publish_job_id),
  CONSTRAINT official_site_daily_batch_items_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT official_site_daily_batch_items_batch_fk
    FOREIGN KEY (batch_id, tenant_id)
    REFERENCES official_site_daily_batches(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT official_site_daily_batch_items_brief_fk
    FOREIGN KEY (brief_id, tenant_id) REFERENCES briefs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT official_site_daily_batch_items_package_fk
    FOREIGN KEY (package_id, tenant_id)
    REFERENCES content_packages(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT official_site_daily_batch_items_variant_fk
    FOREIGN KEY (variant_id, tenant_id)
    REFERENCES content_variants(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT official_site_daily_batch_items_content_version_fk
    FOREIGN KEY (content_version_id, tenant_id)
    REFERENCES content_versions(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT official_site_daily_batch_items_publish_job_fk
    FOREIGN KEY (publish_job_id, tenant_id)
    REFERENCES publish_jobs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT official_site_daily_batch_items_candidate_check
    CHECK (candidate_no BETWEEN 1 AND 30),
  CONSTRAINT official_site_daily_batch_items_angle_check
    CHECK (char_length(btrim(angle_key)) BETWEEN 1 AND 80),
  CONSTRAINT official_site_daily_batch_items_title_check
    CHECK (char_length(btrim(title)) BETWEEN 2 AND 240),
  CONSTRAINT official_site_daily_batch_items_status_check CHECK (
    status IN (
      'generating', 'quality_check', 'rewriting', 'qualified',
      'scheduled', 'published', 'publish_failed', 'reserve', 'retired'
    )
  ),
  CONSTRAINT official_site_daily_batch_items_error_check CHECK (
    last_error_json IS NULL OR jsonb_typeof(last_error_json) = 'object'
  ),
  CONSTRAINT official_site_daily_batch_items_qualified_check CHECK (
    (status IN ('qualified', 'scheduled', 'published', 'publish_failed', 'reserve') AND qualified_at IS NOT NULL)
    OR (status NOT IN ('qualified', 'scheduled', 'published', 'publish_failed', 'reserve') AND qualified_at IS NULL)
  ),
  CONSTRAINT official_site_daily_batch_items_schedule_check CHECK (
    (status IN ('scheduled', 'published', 'publish_failed') AND scheduled_at IS NOT NULL AND publish_job_id IS NOT NULL)
    OR (status NOT IN ('scheduled', 'published', 'publish_failed') AND scheduled_at IS NULL AND publish_job_id IS NULL)
  ),
  CONSTRAINT official_site_daily_batch_items_published_check CHECK (
    (status = 'published' AND published_at IS NOT NULL)
    OR (status <> 'published' AND published_at IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX official_site_daily_batch_items_batch_status_idx
  ON official_site_daily_batch_items (tenant_id, batch_id, status, candidate_no, id);
--> statement-breakpoint
CREATE TRIGGER official_site_daily_batch_items_set_updated_at
  BEFORE UPDATE ON official_site_daily_batch_items
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
