CREATE TABLE content_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  brief_id uuid NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'draft',
  version integer NOT NULL DEFAULT 1,
  master_content_version_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT content_packages_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT content_packages_id_scope_uq UNIQUE (id, tenant_id, workspace_id, project_id),
  CONSTRAINT content_packages_workspace_fk
    FOREIGN KEY (workspace_id, tenant_id)
    REFERENCES workspaces(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT content_packages_project_fk
    FOREIGN KEY (project_id, tenant_id, workspace_id)
    REFERENCES projects(id, tenant_id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT content_packages_brief_fk
    FOREIGN KEY (brief_id, tenant_id, workspace_id, project_id)
    REFERENCES briefs(id, tenant_id, workspace_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT content_packages_created_by_fk
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT content_packages_created_by_membership_fk
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT content_packages_status_check CHECK (
    status IN (
      'draft', 'generating', 'generated', 'all_failed', 'editing', 'in_review',
      'rejected', 'approved', 'scheduled', 'publishing', 'publish_failed',
      'published', 'cancelled', 'archived'
    )
  ),
  CONSTRAINT content_packages_version_check CHECK (version > 0),
  CONSTRAINT content_packages_deleted_status_check
    CHECK (deleted_at IS NULL OR status = 'archived')
);
--> statement-breakpoint
CREATE INDEX content_packages_scope_status_idx
  ON content_packages (
    tenant_id, workspace_id, project_id, status, updated_at DESC, id
  )
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER content_packages_set_updated_at
  BEFORE UPDATE ON content_packages
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE content_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  package_id uuid NOT NULL,
  platform_code varchar(24) NOT NULL,
  current_content_version_id uuid,
  status varchar(24) NOT NULL DEFAULT 'draft',
  is_required boolean NOT NULL DEFAULT true,
  quality_score numeric(5,2),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_variants_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT content_variants_id_package_uq UNIQUE (id, tenant_id, package_id),
  CONSTRAINT content_variants_package_platform_uq
    UNIQUE (tenant_id, package_id, platform_code),
  CONSTRAINT content_variants_package_fk
    FOREIGN KEY (package_id, tenant_id)
    REFERENCES content_packages(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT content_variants_platform_check CHECK (
    platform_code IN (
      'official_site', 'baijiahao', 'toutiao', 'zhihu',
      'xiaohongshu', 'wechat_mp', 'douyin'
    )
  ),
  CONSTRAINT content_variants_status_check CHECK (
    status IN (
      'draft', 'generating', 'generation_failed', 'generated', 'quality_failed',
      'quality_passed', 'in_review', 'review_approved', 'review_rejected',
      'approved', 'scheduled', 'publishing', 'published', 'publish_failed', 'cancelled'
    )
  ),
  CONSTRAINT content_variants_quality_score_check
    CHECK (quality_score IS NULL OR quality_score BETWEEN 0 AND 100),
  CONSTRAINT content_variants_version_check CHECK (version > 0)
);
--> statement-breakpoint
CREATE INDEX content_variants_package_status_idx
  ON content_variants (tenant_id, package_id, status, platform_code, id);
--> statement-breakpoint
CREATE TRIGGER content_variants_set_updated_at
  BEFORE UPDATE ON content_variants
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE FUNCTION enforce_variant_brief_platform()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM content_packages AS package
    JOIN briefs AS brief
      ON brief.id = package.brief_id AND brief.tenant_id = package.tenant_id
    WHERE
      package.id = NEW.package_id
      AND package.tenant_id = NEW.tenant_id
      AND NEW.platform_code = ANY(brief.platform_codes)
  ) THEN
    RAISE EXCEPTION 'content variant platform is not selected by its brief';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER content_variants_brief_platform_guard
  BEFORE INSERT OR UPDATE OF platform_code, package_id ON content_variants
  FOR EACH ROW
  EXECUTE FUNCTION enforce_variant_brief_platform();
--> statement-breakpoint
CREATE TABLE content_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  package_id uuid NOT NULL,
  variant_id uuid,
  version_no integer NOT NULL,
  schema_version varchar(32) NOT NULL,
  content_json jsonb NOT NULL,
  content_hash char(64) NOT NULL,
  source_run_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_versions_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT content_versions_id_package_uq UNIQUE (id, tenant_id, package_id),
  CONSTRAINT content_versions_id_package_variant_uq
    UNIQUE (id, tenant_id, package_id, variant_id),
  CONSTRAINT content_versions_package_fk
    FOREIGN KEY (package_id, tenant_id)
    REFERENCES content_packages(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT content_versions_variant_fk
    FOREIGN KEY (variant_id, tenant_id, package_id)
    REFERENCES content_variants(id, tenant_id, package_id) ON DELETE RESTRICT,
  CONSTRAINT content_versions_source_run_fk
    FOREIGN KEY (source_run_id, tenant_id)
    REFERENCES generation_runs(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT content_versions_created_by_fk
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT content_versions_created_by_membership_fk
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT content_versions_version_no_check CHECK (version_no > 0),
  CONSTRAINT content_versions_schema_version_check
    CHECK (char_length(btrim(schema_version)) BETWEEN 1 AND 32),
  CONSTRAINT content_versions_content_check CHECK (
    COALESCE(
      jsonb_typeof(content_json) = 'object'
      AND content_json->>'schema_version' = schema_version,
      false
    )
  ),
  CONSTRAINT content_versions_content_hash_check
    CHECK (content_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX content_versions_object_version_uq
  ON content_versions (
    tenant_id,
    package_id,
    COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    version_no
  );
--> statement-breakpoint
CREATE UNIQUE INDEX content_versions_object_hash_uq
  ON content_versions (
    tenant_id,
    package_id,
    COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    content_hash
  );
--> statement-breakpoint
CREATE INDEX content_versions_object_created_idx
  ON content_versions (tenant_id, package_id, variant_id, version_no DESC);
--> statement-breakpoint
ALTER TABLE content_packages
  ADD CONSTRAINT content_packages_master_version_fk
  FOREIGN KEY (master_content_version_id, tenant_id, id)
  REFERENCES content_versions(id, tenant_id, package_id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE content_variants
  ADD CONSTRAINT content_variants_current_version_fk
  FOREIGN KEY (current_content_version_id, tenant_id, package_id, id)
  REFERENCES content_versions(id, tenant_id, package_id, variant_id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION enforce_master_content_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.master_content_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM content_versions AS version
    WHERE
      version.id = NEW.master_content_version_id
      AND version.tenant_id = NEW.tenant_id
      AND version.package_id = NEW.id
      AND version.variant_id IS NULL
  ) THEN
    RAISE EXCEPTION 'master content version must be a master version from the same package';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER content_packages_master_version_guard
  BEFORE INSERT OR UPDATE OF master_content_version_id ON content_packages
  FOR EACH ROW
  EXECUTE FUNCTION enforce_master_content_version();
--> statement-breakpoint
CREATE FUNCTION protect_content_version_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'content versions are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER content_versions_append_only_guard
  BEFORE UPDATE OR DELETE ON content_versions
  FOR EACH ROW
  EXECUTE FUNCTION protect_content_version_history();
--> statement-breakpoint
CREATE FUNCTION enforce_content_version_run_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM generation_runs AS run
    JOIN content_packages AS package
      ON package.id = NEW.package_id AND package.tenant_id = NEW.tenant_id
    WHERE
      run.id = NEW.source_run_id
      AND run.tenant_id = NEW.tenant_id
      AND run.package_id = NEW.package_id
      AND run.variant_id IS NOT DISTINCT FROM NEW.variant_id
      AND run.workspace_id = package.workspace_id
      AND run.project_id = package.project_id
  ) THEN
    RAISE EXCEPTION 'content version source run is outside the content object scope';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER content_versions_run_scope_guard
  BEFORE INSERT ON content_versions
  FOR EACH ROW
  EXECUTE FUNCTION enforce_content_version_run_scope();
--> statement-breakpoint
CREATE TABLE content_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  block_key varchar(80) NOT NULL,
  block_type varchar(24) NOT NULL,
  position integer NOT NULL,
  text_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_blocks_version_key_uq
    UNIQUE (tenant_id, content_version_id, block_key),
  CONSTRAINT content_blocks_version_position_uq
    UNIQUE (tenant_id, content_version_id, position),
  CONSTRAINT content_blocks_version_fk
    FOREIGN KEY (content_version_id, tenant_id)
    REFERENCES content_versions(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT content_blocks_key_check
    CHECK (char_length(btrim(block_key)) BETWEEN 1 AND 80),
  CONSTRAINT content_blocks_type_check
    CHECK (block_type IN ('heading', 'paragraph', 'list', 'quote', 'media', 'cta')),
  CONSTRAINT content_blocks_position_check CHECK (position >= 0),
  CONSTRAINT content_blocks_text_hash_check CHECK (text_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE FUNCTION protect_content_block_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'content blocks are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER content_blocks_append_only_guard
  BEFORE UPDATE OR DELETE ON content_blocks
  FOR EACH ROW
  EXECUTE FUNCTION protect_content_block_history();
--> statement-breakpoint
CREATE TABLE content_block_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  block_key varchar(80) NOT NULL,
  locked_content_hash char(64) NOT NULL,
  locked_by uuid NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_block_locks_variant_key_uq
    UNIQUE (tenant_id, variant_id, block_key),
  CONSTRAINT content_block_locks_variant_fk
    FOREIGN KEY (variant_id, tenant_id)
    REFERENCES content_variants(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT content_block_locks_locked_by_fk
    FOREIGN KEY (locked_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT content_block_locks_locked_by_membership_fk
    FOREIGN KEY (tenant_id, locked_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT content_block_locks_key_check
    CHECK (char_length(btrim(block_key)) BETWEEN 1 AND 80),
  CONSTRAINT content_block_locks_hash_check
    CHECK (locked_content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT content_block_locks_reason_check
    CHECK (reason IS NULL OR char_length(btrim(reason)) BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE TRIGGER content_block_locks_set_updated_at
  BEFORE UPDATE ON content_block_locks
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE FUNCTION enforce_content_block_lock_hash()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM content_variants AS variant
    JOIN content_blocks AS block
      ON block.content_version_id = variant.current_content_version_id
      AND block.tenant_id = variant.tenant_id
    WHERE
      variant.id = NEW.variant_id
      AND variant.tenant_id = NEW.tenant_id
      AND block.block_key = NEW.block_key
      AND block.text_hash = NEW.locked_content_hash
  ) THEN
    RAISE EXCEPTION 'block lock hash does not match the current content version';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER content_block_locks_hash_guard
  BEFORE INSERT OR UPDATE ON content_block_locks
  FOR EACH ROW
  EXECUTE FUNCTION enforce_content_block_lock_hash();
--> statement-breakpoint
CREATE TABLE ai_citations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  claim_key varchar(80) NOT NULL,
  claim_text text NOT NULL,
  chunk_id uuid NOT NULL,
  quote_text text NOT NULL,
  quote_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_citations_claim_chunk_quote_uq
    UNIQUE (tenant_id, content_version_id, claim_key, chunk_id, quote_hash),
  CONSTRAINT ai_citations_version_fk
    FOREIGN KEY (content_version_id, tenant_id)
    REFERENCES content_versions(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT ai_citations_chunk_fk
    FOREIGN KEY (chunk_id, tenant_id)
    REFERENCES source_chunks(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT ai_citations_claim_key_check
    CHECK (char_length(btrim(claim_key)) BETWEEN 1 AND 80),
  CONSTRAINT ai_citations_claim_text_check CHECK (char_length(btrim(claim_text)) > 0),
  CONSTRAINT ai_citations_quote_text_check CHECK (char_length(btrim(quote_text)) > 0),
  CONSTRAINT ai_citations_quote_hash_check CHECK (quote_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX ai_citations_chunk_idx
  ON ai_citations (tenant_id, chunk_id, content_version_id);
--> statement-breakpoint
CREATE FUNCTION enforce_ai_citation_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_text text;
BEGIN
  SELECT chunk.text INTO source_text
  FROM source_chunks AS chunk
  JOIN source_documents AS source
    ON source.id = chunk.source_document_id AND source.tenant_id = chunk.tenant_id
  JOIN content_versions AS version
    ON version.id = NEW.content_version_id AND version.tenant_id = NEW.tenant_id
  JOIN content_packages AS package
    ON package.id = version.package_id AND package.tenant_id = version.tenant_id
  WHERE
    chunk.id = NEW.chunk_id
    AND chunk.tenant_id = NEW.tenant_id
    AND source.workspace_id = package.workspace_id
    AND (source.project_id IS NULL OR source.project_id = package.project_id)
    AND source.deleted_at IS NULL
    AND source.status = 'active'
    AND chunk.status = 'active';
  IF source_text IS NULL OR strpos(source_text, NEW.quote_text) = 0 THEN
    RAISE EXCEPTION 'citation quote must be a continuous substring of its source chunk';
  END IF;
  IF encode(digest(convert_to(NEW.quote_text, 'UTF8'), 'sha256'), 'hex') <> NEW.quote_hash THEN
    RAISE EXCEPTION 'citation quote hash does not match quote text';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ai_citations_provenance_guard
  BEFORE INSERT ON ai_citations
  FOR EACH ROW
  EXECUTE FUNCTION enforce_ai_citation_provenance();
--> statement-breakpoint
CREATE FUNCTION protect_ai_citation_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AI citations are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ai_citations_append_only_guard
  BEFORE UPDATE OR DELETE ON ai_citations
  FOR EACH ROW
  EXECUTE FUNCTION protect_ai_citation_history();
--> statement-breakpoint
ALTER TABLE generation_runs
  ADD CONSTRAINT generation_runs_package_fk
    FOREIGN KEY (package_id, tenant_id, workspace_id, project_id)
    REFERENCES content_packages(id, tenant_id, workspace_id, project_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT generation_runs_variant_fk
    FOREIGN KEY (variant_id, tenant_id, package_id)
    REFERENCES content_variants(id, tenant_id, package_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT generation_runs_variant_package_check
    CHECK (variant_id IS NULL OR package_id IS NOT NULL),
  ADD CONSTRAINT generation_runs_content_scope_check
    CHECK (package_id IS NULL OR project_id IS NOT NULL);
--> statement-breakpoint
COMMENT ON TABLE content_versions IS
  'Immutable authority for master and platform-variant content JSON; mutable tables store pointers only.';
