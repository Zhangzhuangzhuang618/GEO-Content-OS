# ADR-0009: Platform tenant contract and optimistic version

- Status: accepted
- Date: 2026-07-16
- Scope: T102 / PLAT-01

## Context

The frozen API baseline already lists four platform tenant endpoints and PLAT-01 depends on them, but no executable DTO, OpenAPI operation, API implementation, or page existed. The suspend and restore endpoints require `resource+version`, while `tenants` had no optimistic-lock column. The frozen database manual also requires tenant creation to atomically establish the owner membership, default workspace, and invitation.

## Decision

- Implement the existing four endpoints without changing the executable API total of 121.
- Require the existing `platform.tenants.manage` permission and `platform_admin` policy.
- Add `tenants.version`, a positive integer incremented by suspend and restore transitions.
- Create the tenant, invited owner identity and membership, default workspace, invitation, and required audit event in one database transaction. Invitation delivery uses the existing email adapter and does not expose its token in API responses or logs.
- Return only platform-level tenant metadata, current-month settled cost aggregates, and status-derived health. Do not return tenant content, document counts, titles, or tenant-owned records.
- Require an active, unexpired support-access grant of at most eight hours before any platform administrator reads tenant content. PLAT-01 can create such a grant but does not add a tenant-content endpoint.
- Suspended tenants immediately fail tenant-scoped session and RBAC checks already enforced by the identity layer. Archived tenants cannot be restored by these endpoints.
- Keep the frozen DOCX files unchanged and read-only.

Contracts, generated OpenAPI, migration 0029, API integration tests, the PLAT-01 page, `PROJECT_CONTEXT.md`, and `CLAUDE.md` are the executable correction surface.
