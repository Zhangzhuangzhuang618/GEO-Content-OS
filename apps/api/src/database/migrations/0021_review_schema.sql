CREATE TABLE prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_name varchar(80) NOT NULL,
  version varchar(32) NOT NULL,
  schema_version varchar(32) NOT NULL,
  system_prompt text NOT NULL,
  task_template text NOT NULL,
  content_hash char(64) NOT NULL UNIQUE,
  status varchar(16) NOT NULL DEFAULT 'draft',
  created_by uuid NOT NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prompt_versions_skill_version_uq UNIQUE (skill_name, version),
  CONSTRAINT prompt_versions_created_by_fk
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT prompt_versions_skill_name_check
    CHECK (char_length(btrim(skill_name)) BETWEEN 1 AND 80),
  CONSTRAINT prompt_versions_version_check CHECK (
    char_length(btrim(version)) BETWEEN 1 AND 32
    AND version ~ '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$'
  ),
  CONSTRAINT prompt_versions_schema_version_check
    CHECK (char_length(btrim(schema_version)) BETWEEN 1 AND 32),
  CONSTRAINT prompt_versions_prompt_check CHECK (
    char_length(btrim(system_prompt)) > 0
    AND char_length(btrim(task_template)) > 0
  ),
  CONSTRAINT prompt_versions_content_hash_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT prompt_versions_status_check CHECK (status IN ('draft', 'published', 'retired')),
  CONSTRAINT prompt_versions_publication_check CHECK (
    (status = 'draft' AND published_at IS NULL)
    OR (status IN ('published', 'retired') AND published_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE TABLE platform_rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_code varchar(24) NOT NULL,
  version varchar(32) NOT NULL,
  rules_json jsonb NOT NULL,
  content_hash char(64) NOT NULL UNIQUE,
  status varchar(16) NOT NULL DEFAULT 'draft',
  created_by uuid NOT NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_rule_versions_platform_version_uq UNIQUE (platform_code, version),
  CONSTRAINT platform_rule_versions_created_by_fk
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT platform_rule_versions_platform_check CHECK (
    platform_code IN (
      'official_site', 'baijiahao', 'toutiao', 'zhihu',
      'xiaohongshu', 'wechat_mp', 'douyin'
    )
  ),
  CONSTRAINT platform_rule_versions_version_check CHECK (
    char_length(btrim(version)) BETWEEN 1 AND 32
    AND version ~ '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$'
  ),
  CONSTRAINT platform_rule_versions_rules_check CHECK (
    COALESCE(
      jsonb_typeof(rules_json) = 'object'
      AND rules_json->>'schema_version' = 'platform-rules@1',
      false
    )
  ),
  CONSTRAINT platform_rule_versions_content_hash_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT platform_rule_versions_status_check CHECK (status IN ('draft', 'published', 'retired')),
  CONSTRAINT platform_rule_versions_publication_check CHECK (
    (status = 'draft' AND published_at IS NULL)
    OR (status IN ('published', 'retired') AND published_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE FUNCTION protect_prompt_version_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'prompt versions cannot be deleted';
  END IF;
  IF ROW(
    NEW.skill_name, NEW.version, NEW.schema_version, NEW.system_prompt,
    NEW.task_template, NEW.content_hash, NEW.created_by, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.skill_name, OLD.version, OLD.schema_version, OLD.system_prompt,
    OLD.task_template, OLD.content_hash, OLD.created_by, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'prompt version content is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER prompt_versions_history_guard
  BEFORE UPDATE OR DELETE ON prompt_versions
  FOR EACH ROW
  EXECUTE FUNCTION protect_prompt_version_history();
--> statement-breakpoint
CREATE FUNCTION protect_platform_rule_version_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'platform rule versions cannot be deleted';
  END IF;
  IF ROW(
    NEW.platform_code, NEW.version, NEW.rules_json, NEW.content_hash,
    NEW.created_by, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.platform_code, OLD.version, OLD.rules_json, OLD.content_hash,
    OLD.created_by, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'platform rule version content is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER platform_rule_versions_history_guard
  BEFORE UPDATE OR DELETE ON platform_rule_versions
  FOR EACH ROW
  EXECUTE FUNCTION protect_platform_rule_version_history();
--> statement-breakpoint
ALTER TABLE ai_citations
  ADD CONSTRAINT ai_citations_id_tenant_uq UNIQUE (id, tenant_id);
--> statement-breakpoint
CREATE TABLE review_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  package_id uuid NOT NULL,
  snapshot_hash char(64) NOT NULL,
  brand_profile_id uuid NOT NULL,
  prompt_version_id uuid NOT NULL,
  model_key varchar(80) NOT NULL,
  platform_rules_hash char(64) NOT NULL,
  quality_rules_hash char(64) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'in_review',
  version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_snapshots_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT review_snapshots_tenant_hash_uq UNIQUE (tenant_id, snapshot_hash),
  CONSTRAINT review_snapshots_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT review_snapshots_package_fk
    FOREIGN KEY (package_id, tenant_id)
    REFERENCES content_packages(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT review_snapshots_brand_profile_fk
    FOREIGN KEY (brand_profile_id, tenant_id)
    REFERENCES brand_profiles(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT review_snapshots_prompt_version_fk
    FOREIGN KEY (prompt_version_id) REFERENCES prompt_versions(id) ON DELETE RESTRICT,
  CONSTRAINT review_snapshots_created_by_fk
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT review_snapshots_created_by_membership_fk
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT review_snapshots_hash_check CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT review_snapshots_model_key_check
    CHECK (char_length(btrim(model_key)) BETWEEN 1 AND 80),
  CONSTRAINT review_snapshots_platform_rules_hash_check
    CHECK (platform_rules_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT review_snapshots_quality_rules_hash_check
    CHECK (quality_rules_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT review_snapshots_status_check
    CHECK (status IN ('in_review', 'approved', 'rejected', 'superseded')),
  CONSTRAINT review_snapshots_version_check CHECK (version > 0)
);
--> statement-breakpoint
CREATE INDEX review_snapshots_package_status_idx
  ON review_snapshots (tenant_id, package_id, status, created_at DESC, id);
--> statement-breakpoint
CREATE TRIGGER review_snapshots_set_updated_at
  BEFORE UPDATE ON review_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE FUNCTION enforce_review_snapshot_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM content_packages AS package
    JOIN brand_profiles AS brand
      ON brand.id = NEW.brand_profile_id
      AND brand.tenant_id = package.tenant_id
      AND brand.workspace_id = package.workspace_id
    WHERE package.id = NEW.package_id
      AND package.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'review snapshot brand profile is outside the package scope';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER review_snapshots_scope_guard
  BEFORE INSERT OR UPDATE OF tenant_id, package_id, brand_profile_id ON review_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION enforce_review_snapshot_scope();
--> statement-breakpoint
CREATE FUNCTION protect_review_snapshot_frozen_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'review snapshots cannot be deleted';
  END IF;
  IF ROW(
    NEW.tenant_id, NEW.package_id, NEW.snapshot_hash, NEW.brand_profile_id,
    NEW.prompt_version_id, NEW.model_key, NEW.platform_rules_hash,
    NEW.quality_rules_hash, NEW.created_by, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id, OLD.package_id, OLD.snapshot_hash, OLD.brand_profile_id,
    OLD.prompt_version_id, OLD.model_key, OLD.platform_rules_hash,
    OLD.quality_rules_hash, OLD.created_by, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'review snapshot frozen fields are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER review_snapshots_frozen_fields_guard
  BEFORE UPDATE OR DELETE ON review_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION protect_review_snapshot_frozen_fields();
--> statement-breakpoint
CREATE TABLE review_snapshot_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  content_hash char(64) NOT NULL,
  platform_rule_version_id uuid NOT NULL,
  quality_report_id uuid NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'in_review',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_snapshot_variants_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT review_snapshot_variants_snapshot_variant_uq
    UNIQUE (tenant_id, snapshot_id, variant_id),
  CONSTRAINT review_snapshot_variants_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT review_snapshot_variants_snapshot_fk
    FOREIGN KEY (snapshot_id, tenant_id)
    REFERENCES review_snapshots(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT review_snapshot_variants_variant_fk
    FOREIGN KEY (variant_id, tenant_id)
    REFERENCES content_variants(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT review_snapshot_variants_content_version_fk
    FOREIGN KEY (content_version_id, tenant_id)
    REFERENCES content_versions(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT review_snapshot_variants_platform_rule_fk
    FOREIGN KEY (platform_rule_version_id)
    REFERENCES platform_rule_versions(id) ON DELETE RESTRICT,
  CONSTRAINT review_snapshot_variants_quality_report_fk
    FOREIGN KEY (quality_report_id, tenant_id)
    REFERENCES quality_reports(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT review_snapshot_variants_content_hash_check
    CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT review_snapshot_variants_status_check
    CHECK (status IN ('in_review', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE FUNCTION enforce_review_snapshot_variant_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM review_snapshots AS snapshot
    JOIN content_variants AS variant
      ON variant.id = NEW.variant_id
      AND variant.tenant_id = NEW.tenant_id
      AND variant.package_id = snapshot.package_id
    JOIN content_versions AS version
      ON version.id = NEW.content_version_id
      AND version.tenant_id = NEW.tenant_id
      AND version.package_id = snapshot.package_id
      AND version.variant_id = variant.id
      AND version.content_hash = NEW.content_hash
    JOIN quality_reports AS report
      ON report.id = NEW.quality_report_id
      AND report.tenant_id = NEW.tenant_id
      AND report.variant_id = variant.id
      AND report.content_version_id = version.id
      AND report.decision = 'pass'
    JOIN platform_rule_versions AS platform_rule
      ON platform_rule.id = NEW.platform_rule_version_id
      AND platform_rule.platform_code = variant.platform_code
    WHERE snapshot.id = NEW.snapshot_id
      AND snapshot.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'review snapshot variant is outside the frozen content scope';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER review_snapshot_variants_scope_guard
  BEFORE INSERT OR UPDATE OF
    tenant_id, snapshot_id, variant_id, content_version_id, content_hash,
    platform_rule_version_id, quality_report_id
  ON review_snapshot_variants
  FOR EACH ROW
  EXECUTE FUNCTION enforce_review_snapshot_variant_scope();
--> statement-breakpoint
CREATE FUNCTION protect_review_snapshot_variant_frozen_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'review snapshot variants cannot be deleted';
  END IF;
  IF ROW(
    NEW.tenant_id, NEW.snapshot_id, NEW.variant_id, NEW.content_version_id,
    NEW.content_hash, NEW.platform_rule_version_id, NEW.quality_report_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id, OLD.snapshot_id, OLD.variant_id, OLD.content_version_id,
    OLD.content_hash, OLD.platform_rule_version_id, OLD.quality_report_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'review snapshot variant frozen fields are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER review_snapshot_variants_frozen_fields_guard
  BEFORE UPDATE OR DELETE ON review_snapshot_variants
  FOR EACH ROW
  EXECUTE FUNCTION protect_review_snapshot_variant_frozen_fields();
--> statement-breakpoint
CREATE TABLE review_snapshot_citations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  snapshot_variant_id uuid NOT NULL,
  ai_citation_id uuid NOT NULL,
  citation_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_snapshot_citations_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT review_snapshot_citations_variant_citation_uq
    UNIQUE (tenant_id, snapshot_variant_id, ai_citation_id),
  CONSTRAINT review_snapshot_citations_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT review_snapshot_citations_snapshot_variant_fk
    FOREIGN KEY (snapshot_variant_id, tenant_id)
    REFERENCES review_snapshot_variants(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT review_snapshot_citations_ai_citation_fk
    FOREIGN KEY (ai_citation_id, tenant_id)
    REFERENCES ai_citations(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT review_snapshot_citations_hash_check
    CHECK (citation_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE FUNCTION enforce_review_snapshot_citation_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM review_snapshot_variants AS snapshot_variant
    JOIN ai_citations AS citation
      ON citation.id = NEW.ai_citation_id
      AND citation.tenant_id = NEW.tenant_id
      AND citation.content_version_id = snapshot_variant.content_version_id
    WHERE snapshot_variant.id = NEW.snapshot_variant_id
      AND snapshot_variant.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'review citation is outside the frozen content version';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER review_snapshot_citations_scope_guard
  BEFORE INSERT ON review_snapshot_citations
  FOR EACH ROW
  EXECUTE FUNCTION enforce_review_snapshot_citation_scope();
--> statement-breakpoint
CREATE FUNCTION protect_review_snapshot_citation_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'review snapshot citations are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER review_snapshot_citations_append_only_guard
  BEFORE UPDATE OR DELETE ON review_snapshot_citations
  FOR EACH ROW
  EXECUTE FUNCTION protect_review_snapshot_citation_history();
--> statement-breakpoint
CREATE TABLE review_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  variant_id uuid,
  required_role varchar(32),
  required_user_id uuid,
  status varchar(16) NOT NULL DEFAULT 'pending',
  requested_by uuid NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_requirements_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT review_requirements_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT review_requirements_snapshot_fk
    FOREIGN KEY (snapshot_id, tenant_id)
    REFERENCES review_snapshots(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT review_requirements_variant_fk
    FOREIGN KEY (variant_id, tenant_id)
    REFERENCES content_variants(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT review_requirements_required_user_fk
    FOREIGN KEY (required_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT review_requirements_required_user_membership_fk
    FOREIGN KEY (tenant_id, required_user_id)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT review_requirements_requested_by_fk
    FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT review_requirements_requested_by_membership_fk
    FOREIGN KEY (tenant_id, requested_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT review_requirements_target_check CHECK (
    (required_role IS NULL) <> (required_user_id IS NULL)
  ),
  CONSTRAINT review_requirements_role_check CHECK (
    required_role IS NULL OR required_role IN (
      'tenant_owner', 'tenant_admin', 'strategy_editor', 'content_editor',
      'reviewer', 'publisher', 'analyst', 'viewer'
    )
  ),
  CONSTRAINT review_requirements_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  CONSTRAINT review_requirements_completion_check CHECK (
    (status = 'pending' AND completed_at IS NULL)
    OR (status IN ('approved', 'rejected', 'cancelled') AND completed_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX review_requirements_snapshot_status_idx
  ON review_requirements (tenant_id, snapshot_id, status, created_at, id);
--> statement-breakpoint
CREATE TRIGGER review_requirements_set_updated_at
  BEFORE UPDATE ON review_requirements
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE FUNCTION enforce_review_requirement_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.variant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM review_snapshot_variants AS snapshot_variant
    WHERE snapshot_variant.snapshot_id = NEW.snapshot_id
      AND snapshot_variant.tenant_id = NEW.tenant_id
      AND snapshot_variant.variant_id = NEW.variant_id
  ) THEN
    RAISE EXCEPTION 'review requirement variant is outside the snapshot scope';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER review_requirements_scope_guard
  BEFORE INSERT OR UPDATE OF tenant_id, snapshot_id, variant_id ON review_requirements
  FOR EACH ROW
  EXECUTE FUNCTION enforce_review_requirement_scope();
--> statement-breakpoint
CREATE TABLE review_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  reviewer_id uuid NOT NULL,
  action varchar(24) NOT NULL,
  variant_ids uuid[] NOT NULL,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_actions_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT review_actions_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT review_actions_snapshot_fk
    FOREIGN KEY (snapshot_id, tenant_id)
    REFERENCES review_snapshots(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT review_actions_reviewer_fk
    FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT review_actions_reviewer_membership_fk
    FOREIGN KEY (tenant_id, reviewer_id)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT review_actions_action_check
    CHECK (action IN ('approve', 'reject', 'request_signoff', 'comment')),
  CONSTRAINT review_actions_variant_ids_check
    CHECK (array_position(variant_ids, NULL) IS NULL),
  CONSTRAINT review_actions_reject_comment_check CHECK (
    action <> 'reject' OR COALESCE(char_length(btrim(comment)) > 0, false)
  ),
  CONSTRAINT review_actions_comment_check
    CHECK (comment IS NULL OR char_length(btrim(comment)) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE INDEX review_actions_snapshot_created_idx
  ON review_actions (tenant_id, snapshot_id, created_at, id);
--> statement-breakpoint
CREATE FUNCTION enforce_review_action_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF cardinality(NEW.variant_ids) <> (
    SELECT count(DISTINCT selected.variant_id)::integer
    FROM unnest(NEW.variant_ids) AS selected(variant_id)
  ) THEN
    RAISE EXCEPTION 'review action variants must not contain duplicates';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(NEW.variant_ids) AS selected(variant_id)
    WHERE NOT EXISTS (
      SELECT 1
      FROM review_snapshot_variants AS snapshot_variant
      WHERE snapshot_variant.snapshot_id = NEW.snapshot_id
        AND snapshot_variant.tenant_id = NEW.tenant_id
        AND snapshot_variant.variant_id = selected.variant_id
    )
  ) THEN
    RAISE EXCEPTION 'review action variants must be a subset of the snapshot';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER review_actions_scope_guard
  BEFORE INSERT ON review_actions
  FOR EACH ROW
  EXECUTE FUNCTION enforce_review_action_scope();
--> statement-breakpoint
CREATE FUNCTION protect_review_action_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'review actions are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER review_actions_append_only_guard
  BEFORE UPDATE OR DELETE ON review_actions
  FOR EACH ROW
  EXECUTE FUNCTION protect_review_action_history();
--> statement-breakpoint
COMMENT ON TABLE review_snapshots IS
  'Review authority header that freezes content, prompt, model, rules, and citation inputs.';
