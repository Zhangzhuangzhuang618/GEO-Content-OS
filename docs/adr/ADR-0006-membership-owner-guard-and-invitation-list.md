# ADR-0006: Membership owner guard and invitation list

- Status: accepted
- Date: 2026-07-16
- Scope: T098 / SET-01

## Context

SET-01 must display members and invitations, including invitation status and expiry, and must prevent demoting or disabling the last active tenant owner. The frozen contract listed member mutations and invitation creation/revocation but omitted invitation listing. The database manual defined `memberships.version`, while the executable migration history had not created that column. An application-only owner count check would not protect direct SQL or concurrent requests.

## Decision

- Add tenant-scoped `GET /invitations` with cursor pagination and filters for email and computed status. It returns no invitation token or token hash.
- Implement the four frozen membership endpoints with role authorization, workspace scope validation, optimistic version checks, audit events, and tenant isolation.
- Add migration `0027_membership_version_owner_guard.sql` to reconcile the documented `memberships.version` field and install a database trigger that rejects role or status updates which would leave a tenant without an active owner.
- Serialize owner-role changes per tenant with a transaction advisory lock so concurrent requests cannot bypass the invariant.
- Keep invitation revocation on its existing endpoint. T098 does not change its pre-existing contract or storage model.
- Keep the frozen DOCX files unchanged and read-only.

This correction raises the executable API total from 120 to 121. Contracts, generated OpenAPI, migrations, `PROJECT_CONTEXT.md`, and `CLAUDE.md` are the executable correction surface.
