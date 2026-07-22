ALTER TABLE content_variants
  ADD COLUMN platform_account_id uuid;
--> statement-breakpoint
ALTER TABLE content_variants
  ADD CONSTRAINT content_variants_platform_account_fk
  FOREIGN KEY (platform_account_id, tenant_id)
  REFERENCES platform_accounts(id, tenant_id)
  ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX content_variants_account_idx
  ON content_variants (tenant_id, platform_account_id, package_id)
  WHERE platform_account_id IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION enforce_content_variant_platform_account()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.platform_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM platform_accounts AS account
    JOIN content_packages AS package
      ON package.id = NEW.package_id
      AND package.tenant_id = NEW.tenant_id
      AND package.workspace_id = account.workspace_id
    WHERE
      account.id = NEW.platform_account_id
      AND account.tenant_id = NEW.tenant_id
      AND account.platform_code = NEW.platform_code
      AND account.status = 'active'
      AND account.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'content variant platform account is outside the package target scope';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER content_variants_platform_account_guard
  BEFORE INSERT OR UPDATE OF platform_account_id, platform_code, package_id
  ON content_variants
  FOR EACH ROW
  EXECUTE FUNCTION enforce_content_variant_platform_account();
