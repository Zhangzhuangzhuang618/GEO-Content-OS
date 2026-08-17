ALTER TABLE browser_platform_daily_batches
  ADD COLUMN attempt_no smallint NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE browser_platform_daily_batches
  DROP CONSTRAINT browser_platform_daily_batches_policy_date_uq,
  ADD CONSTRAINT browser_platform_daily_batches_policy_date_attempt_uq
    UNIQUE (tenant_id, policy_id, business_date, attempt_no),
  ADD CONSTRAINT browser_platform_daily_batches_attempt_no_check CHECK (attempt_no > 0);
--> statement-breakpoint
CREATE UNIQUE INDEX browser_platform_daily_batches_one_active_uq
  ON browser_platform_daily_batches (tenant_id, policy_id, business_date)
  WHERE status IN ('running', 'scheduled');
