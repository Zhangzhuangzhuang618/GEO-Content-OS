CREATE FUNCTION is_valid_nonblank_jsonb_string_array(
  input_value jsonb,
  minimum_items integer,
  maximum_items integer
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT
    jsonb_typeof(input_value) = 'array'
    AND jsonb_array_length(input_value) BETWEEN minimum_items AND maximum_items
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(input_value) AS item
      WHERE
        jsonb_typeof(item) <> 'string'
        OR btrim(item #>> '{}') = ''
        OR char_length(btrim(item #>> '{}')) > 500
    )
    AND jsonb_array_length(input_value) = (
      SELECT count(DISTINCT lower(btrim(item #>> '{}')))::integer
      FROM jsonb_array_elements(input_value) AS item
    );
$$;
--> statement-breakpoint
ALTER TABLE brand_profiles
  DROP CONSTRAINT brand_profiles_schema_version_check,
  DROP CONSTRAINT brand_profiles_profile_check,
  ADD CONSTRAINT brand_profiles_schema_version_check
    CHECK (schema_version = 'brand-profile@1'),
  ADD CONSTRAINT brand_profiles_profile_check CHECK (
    COALESCE(
      jsonb_typeof(profile_json) = 'object'
      AND profile_json ?& ARRAY[
        'positioning',
        'audience',
        'tone',
        'differentiators',
        'compliance',
        'banned',
        'cta'
      ]
      AND profile_json - ARRAY[
        'positioning',
        'audience',
        'tone',
        'differentiators',
        'compliance',
        'banned',
        'cta'
      ]::text[] = '{}'::jsonb
      AND jsonb_typeof(profile_json->'positioning') = 'string'
      AND char_length(btrim(profile_json->>'positioning')) BETWEEN 1 AND 2000
      AND is_valid_nonblank_jsonb_string_array(profile_json->'audience', 1, 50)
      AND jsonb_typeof(profile_json->'tone') = 'string'
      AND char_length(btrim(profile_json->>'tone')) BETWEEN 1 AND 240
      AND is_valid_nonblank_jsonb_string_array(profile_json->'differentiators', 0, 50)
      AND is_valid_nonblank_jsonb_string_array(profile_json->'compliance', 0, 100)
      AND is_valid_nonblank_jsonb_string_array(profile_json->'banned', 0, 100)
      AND (
        profile_json->'cta' = 'null'::jsonb
        OR (
          jsonb_typeof(profile_json->'cta') = 'string'
          AND char_length(btrim(profile_json->>'cta')) BETWEEN 1 AND 500
        )
      ),
      false
    )
  );
--> statement-breakpoint
CREATE FUNCTION has_workspace_scope_access(
  input_tenant_id uuid,
  input_workspace_id uuid,
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
        )
      )
  );
$$;
