CREATE OR REPLACE FUNCTION set_row_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL,
  password_hash varchar(255),
  password_changed_at timestamptz,
  display_name varchar(80) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'invited',
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT users_display_name_check
    CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 80),
  CONSTRAINT users_status_check CHECK (status IN ('invited', 'active', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX users_email_active_uq
  ON users (email)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX users_status_idx
  ON users (status, created_at)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE platform_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role_code varchar(32) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'active',
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_roles_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT platform_roles_granted_by_fk
    FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT platform_roles_role_code_check
    CHECK (role_code IN ('platform_admin', 'platform_operator')),
  CONSTRAINT platform_roles_status_check CHECK (status IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE INDEX platform_roles_user_status_idx
  ON platform_roles (user_id, status);
--> statement-breakpoint
CREATE TRIGGER platform_roles_set_updated_at
  BEFORE UPDATE ON platform_roles
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL,
  slug citext NOT NULL,
  plan_code varchar(32) NOT NULL DEFAULT 'trial',
  timezone varchar(64) NOT NULL DEFAULT 'Asia/Shanghai',
  status varchar(16) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT tenants_status_check CHECK (status IN ('active', 'suspended', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX tenants_slug_active_uq
  ON tenants (slug)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX tenants_status_idx
  ON tenants (status, created_at)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER tenants_set_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role_code varchar(32) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'invited',
  invited_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memberships_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT memberships_tenant_user_uq UNIQUE (tenant_id, user_id),
  CONSTRAINT memberships_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT memberships_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT memberships_invited_by_fk
    FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT memberships_role_code_check CHECK (
    role_code IN (
      'tenant_owner',
      'tenant_admin',
      'strategy_editor',
      'content_editor',
      'reviewer',
      'publisher',
      'analyst',
      'viewer'
    )
  ),
  CONSTRAINT memberships_status_check CHECK (status IN ('invited', 'active', 'disabled'))
);
--> statement-breakpoint
CREATE INDEX memberships_user_status_idx
  ON memberships (user_id, status, updated_at DESC);
--> statement-breakpoint
CREATE INDEX memberships_tenant_status_idx
  ON memberships (tenant_id, status, created_at);
--> statement-breakpoint
CREATE TRIGGER memberships_set_updated_at
  BEFORE UPDATE ON memberships
  FOR EACH ROW
  EXECUTE FUNCTION set_row_updated_at();
--> statement-breakpoint
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  active_tenant_id uuid,
  session_hash char(64) NOT NULL,
  csrf_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT sessions_active_membership_fk
    FOREIGN KEY (active_tenant_id, user_id)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT sessions_session_hash_uq UNIQUE (session_hash),
  CONSTRAINT sessions_session_hash_check CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sessions_csrf_hash_check CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sessions_expiry_check CHECK (expires_at > created_at)
);
--> statement-breakpoint
CREATE INDEX sessions_user_valid_idx
  ON sessions (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX sessions_expiry_idx
  ON sessions (expires_at)
  WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  email citext NOT NULL,
  role_code varchar(32) NOT NULL,
  workspace_scope_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  token_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  invited_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitations_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT invitations_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT invitations_invited_by_fk
    FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT invitations_token_hash_uq UNIQUE (token_hash),
  CONSTRAINT invitations_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT invitations_role_code_check CHECK (
    role_code IN (
      'tenant_owner',
      'tenant_admin',
      'strategy_editor',
      'content_editor',
      'reviewer',
      'publisher',
      'analyst',
      'viewer'
    )
  ),
  CONSTRAINT invitations_expiry_check CHECK (expires_at > created_at)
);
--> statement-breakpoint
CREATE INDEX invitations_tenant_pending_idx
  ON invitations (tenant_id, email, expires_at DESC)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX invitations_expiry_idx
  ON invitations (expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
