CREATE TABLE wentian_project_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  wentian_binding_id uuid NOT NULL,
  wentian_scope_id uuid,
  geo_project_ref varchar(160) NOT NULL,
  status varchar(30) NOT NULL,
  contract_version varchar(80) NOT NULL DEFAULT 'wentian-geo-connector@1',
  decision_reason varchar(500),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT wentian_project_bindings_id_scope_uq
    UNIQUE (id, tenant_id, workspace_id, project_id),
  CONSTRAINT wentian_project_bindings_remote_uq UNIQUE (wentian_binding_id),
  CONSTRAINT wentian_project_bindings_project_fk
    FOREIGN KEY (project_id, tenant_id, workspace_id)
    REFERENCES projects(id, tenant_id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT wentian_project_bindings_requested_by_fk
    FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT wentian_project_bindings_requested_by_membership_fk
    FOREIGN KEY (tenant_id, requested_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT wentian_project_bindings_status_check CHECK (
    status IN ('pending_wentian', 'active', 'suspended', 'rejected', 'disconnected')
  ),
  CONSTRAINT wentian_project_bindings_contract_check
    CHECK (contract_version = 'wentian-geo-connector@1'),
  CONSTRAINT wentian_project_bindings_geo_project_check
    CHECK (char_length(btrim(geo_project_ref)) BETWEEN 1 AND 160),
  CONSTRAINT wentian_project_bindings_version_check CHECK (version > 0),
  CONSTRAINT wentian_project_bindings_scope_status_check CHECK (
    (status IN ('pending_wentian', 'rejected') AND wentian_scope_id IS NULL)
    OR (status IN ('active', 'suspended') AND wentian_scope_id IS NOT NULL)
    OR status = 'disconnected'
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX wentian_project_bindings_one_open_uq
  ON wentian_project_bindings (tenant_id, project_id)
  WHERE status IN ('pending_wentian', 'active', 'suspended');
--> statement-breakpoint
CREATE INDEX wentian_project_bindings_project_history_idx
  ON wentian_project_bindings (
    tenant_id, workspace_id, project_id, requested_at DESC, id
  );
--> statement-breakpoint
CREATE TABLE wentian_query_set_syncs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  query_set_id uuid NOT NULL,
  query_set_revision integer NOT NULL,
  wentian_snapshot_id uuid NOT NULL,
  snapshot_hash char(64) NOT NULL,
  query_count integer NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  synced_by uuid NOT NULL,
  synced_at timestamptz NOT NULL,
  CONSTRAINT wentian_query_set_syncs_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT wentian_query_set_syncs_binding_revision_uq
    UNIQUE (tenant_id, binding_id, query_set_id, query_set_revision),
  CONSTRAINT wentian_query_set_syncs_idempotency_uq
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT wentian_query_set_syncs_binding_fk
    FOREIGN KEY (binding_id, tenant_id, workspace_id, project_id)
    REFERENCES wentian_project_bindings(id, tenant_id, workspace_id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT wentian_query_set_syncs_query_set_fk
    FOREIGN KEY (query_set_id, tenant_id, workspace_id, project_id)
    REFERENCES ai_visibility_query_sets(id, tenant_id, workspace_id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT wentian_query_set_syncs_synced_by_fk
    FOREIGN KEY (synced_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT wentian_query_set_syncs_synced_by_membership_fk
    FOREIGN KEY (tenant_id, synced_by)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT wentian_query_set_syncs_revision_check CHECK (query_set_revision > 0),
  CONSTRAINT wentian_query_set_syncs_hash_check CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT wentian_query_set_syncs_count_check CHECK (query_count BETWEEN 1 AND 100),
  CONSTRAINT wentian_query_set_syncs_idempotency_check
    CHECK (char_length(btrim(idempotency_key)) BETWEEN 8 AND 128)
);
--> statement-breakpoint
CREATE INDEX wentian_query_set_syncs_project_time_idx
  ON wentian_query_set_syncs (
    tenant_id, workspace_id, project_id, synced_at DESC, id
  );
