CREATE TABLE support_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  platform_user_id uuid NOT NULL,
  scope_json jsonb NOT NULL,
  reason text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  granted_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_access_grants_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT support_access_grants_platform_user_fk
    FOREIGN KEY (platform_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT support_access_grants_granted_by_fk
    FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT support_access_grants_reason_check
    CHECK (char_length(btrim(reason)) BETWEEN 1 AND 2000),
  CONSTRAINT support_access_grants_expiry_check
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '8 hours'),
  CONSTRAINT support_access_grants_revoked_at_check
    CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CONSTRAINT support_access_grants_scope_check CHECK (
    COALESCE(
      jsonb_typeof(scope_json) = 'object'
      AND scope_json->>'schema_version' = 'support-access@1'
      AND scope_json - ARRAY['schema_version', 'permissions', 'resource_types'] = '{}'::jsonb
      AND jsonb_typeof(scope_json->'permissions') = 'array'
      AND jsonb_array_length(scope_json->'permissions') BETWEEN 1 AND 32
      AND NOT jsonb_path_exists(
        scope_json,
        '$.permissions[*] ? (@.type() != "string" || @ == "")'
      )
      AND jsonb_typeof(scope_json->'resource_types') = 'array'
      AND jsonb_array_length(scope_json->'resource_types') BETWEEN 1 AND 64
      AND NOT jsonb_path_exists(
        scope_json,
        '$.resource_types[*] ? (@.type() != "string" || @ == "")'
      ),
      false
    )
  )
);
--> statement-breakpoint
CREATE INDEX support_access_grants_active_lookup_idx
  ON support_access_grants (platform_user_id, tenant_id, expires_at DESC)
  WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX support_access_grants_tenant_created_idx
  ON support_access_grants (tenant_id, created_at DESC);
--> statement-breakpoint
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  actor_id uuid,
  support_access_grant_id uuid,
  action varchar(80) NOT NULL,
  resource_type varchar(64) NOT NULL,
  resource_id uuid,
  before_json jsonb,
  after_json jsonb,
  ip inet,
  request_id varchar(80) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT audit_events_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT audit_events_actor_fk
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT audit_events_support_access_grant_fk
    FOREIGN KEY (support_access_grant_id) REFERENCES support_access_grants(id) ON DELETE RESTRICT,
  CONSTRAINT audit_events_action_check CHECK (char_length(btrim(action)) BETWEEN 1 AND 80),
  CONSTRAINT audit_events_resource_type_check
    CHECK (char_length(btrim(resource_type)) BETWEEN 1 AND 64),
  CONSTRAINT audit_events_request_id_check
    CHECK (char_length(btrim(request_id)) BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE INDEX audit_events_tenant_created_idx
  ON audit_events (tenant_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX audit_events_resource_time_idx
  ON audit_events (tenant_id, resource_type, resource_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX audit_events_support_access_idx
  ON audit_events (support_access_grant_id, created_at DESC)
  WHERE support_access_grant_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX audit_events_request_id_idx
  ON audit_events (request_id, created_at DESC);
--> statement-breakpoint
CREATE FUNCTION protect_support_access_grant_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'support access grant history is append-only';
  END IF;

  IF ROW(
    NEW.id,
    NEW.tenant_id,
    NEW.platform_user_id,
    NEW.scope_json,
    NEW.reason,
    NEW.expires_at,
    NEW.granted_by,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id,
    OLD.tenant_id,
    OLD.platform_user_id,
    OLD.scope_json,
    OLD.reason,
    OLD.expires_at,
    OLD.granted_by,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'support access grant identity and scope are immutable';
  END IF;

  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'support access grant only allows one-way revocation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER support_access_grants_update_guard
  BEFORE UPDATE ON support_access_grants
  FOR EACH ROW
  EXECUTE FUNCTION protect_support_access_grant_history();
--> statement-breakpoint
CREATE TRIGGER support_access_grants_delete_guard
  BEFORE DELETE ON support_access_grants
  FOR EACH ROW
  EXECUTE FUNCTION protect_support_access_grant_history();
--> statement-breakpoint
CREATE FUNCTION protect_audit_event_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only_guard
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW
  EXECUTE FUNCTION protect_audit_event_history();
