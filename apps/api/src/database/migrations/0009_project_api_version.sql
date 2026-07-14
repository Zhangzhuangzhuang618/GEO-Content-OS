ALTER TABLE projects
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT projects_version_check CHECK (version > 0);
--> statement-breakpoint
CREATE INDEX projects_tenant_version_idx
  ON projects (tenant_id, id, version)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE FUNCTION has_project_scope_access(
  input_tenant_id uuid,
  input_workspace_id uuid,
  input_project_id uuid,
  input_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM memberships AS membership
    JOIN users AS identity_user ON identity_user.id = membership.user_id
    JOIN tenants AS tenant ON tenant.id = membership.tenant_id
    WHERE
      membership.tenant_id = input_tenant_id
      AND membership.user_id = input_user_id
      AND membership.status = 'active'
      AND identity_user.status = 'active'
      AND identity_user.deleted_at IS NULL
      AND tenant.status = 'active'
      AND tenant.deleted_at IS NULL
      AND (
        membership.role_code IN ('tenant_owner', 'tenant_admin')
        OR NOT EXISTS (
          SELECT 1
          FROM workspace_memberships AS any_workspace_scope
          JOIN workspaces AS scoped_workspace
            ON scoped_workspace.id = any_workspace_scope.workspace_id
          WHERE
            any_workspace_scope.user_id = input_user_id
            AND scoped_workspace.tenant_id = input_tenant_id
            AND scoped_workspace.deleted_at IS NULL
        )
        OR EXISTS (
          SELECT 1
          FROM workspace_memberships AS selected_scope
          WHERE
            selected_scope.user_id = input_user_id
            AND selected_scope.workspace_id = input_workspace_id
            AND (
              (
                input_project_id IS NULL
                AND NOT (selected_scope.scope_json ? 'project_ids')
              )
              OR (
                input_project_id IS NOT NULL
                AND (
                  NOT (selected_scope.scope_json ? 'project_ids')
                  OR (
                    jsonb_typeof(selected_scope.scope_json->'project_ids') = 'array'
                    AND (selected_scope.scope_json->'project_ids') ? input_project_id::text
                  )
                )
              )
            )
        )
      )
  );
$$;
