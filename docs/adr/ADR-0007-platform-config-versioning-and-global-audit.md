# ADR-0007: Platform configuration versioning and global audit

- Status: accepted
- Date: 2026-07-16
- Scope: T100 / SET-03

## Context

SET-03 manages immutable Prompt and platform-rule versions. The frozen API already contains eight list, create, publish, and retire endpoints, but the database lacked the required change summary, publisher, and optimistic-lock fields. The database column named `version` stores a semantic version, while the shared mutable-resource contract also requires an integer `version`. Platform configuration is global rather than tenant-owned, so tenant-required idempotency and audit rows could not represent these writes correctly.

## Decision

- Keep the existing eight endpoints and the executable API total at 121.
- Expose the stored semantic version as `semantic_version`; expose `lock_version` as integer `version` and use it with `If-Match` for publish and retire transitions.
- Add `change_summary`, `published_by`, and `lock_version` to `prompt_versions` and `platform_rule_versions`.
- Preserve immutable version content with database triggers. Published versions have no update endpoint; rollback retires the published version, and any restored behavior is created as a new version.
- Permit `tenant_id = NULL` only where existing shared infrastructure represents a global platform operation: `idempotency_records` and `audit_events`. Null-tenant idempotency keys use `UNIQUE NULLS NOT DISTINCT` so retries remain deterministic.
- Keep `support_access_grants.tenant_id` required because support access always targets one tenant.
- Limit the SET-03 “test” action to local contract/schema validation. It does not call a model or any real platform.
- Keep the frozen DOCX files unchanged and read-only.

Migration `0028_platform_config_contract.sql`, contracts, generated OpenAPI, Drizzle schema, tests, and `PROJECT_CONTEXT.md` are the executable correction surface.
