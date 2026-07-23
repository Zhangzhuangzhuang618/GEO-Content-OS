# ADR-0013: Complete quality-check runtime and human account navigation

- Status: accepted
- Date: 2026-07-18
- Scope: user-authorized defect correction; no public endpoint or database table added

## Context

The API could create a `content.variant.quality_check_requested.v1` run, but the AI Worker only
consumed content-generation events. The quality page displayed an empty report as a terminal state,
and the package page could not start the missing first check. Consequently, generated content could
not reach the existing submit-review gate through the user interface.

The authenticated application header also exposed no persistent account controls. A user could not
reliably discover how to log out, switch account, or switch enterprise after entering the workspace.

## Decision

- Dispatch quality-check events to a dedicated Worker path and execute the published
  `quality-checker` Skill through the configured model adapter.
- Keep tenant, run, content version, hashes, report envelope, usage, status transitions, and audit
  data server-owned. The model returns only quality data defined by the Skill data schema.
- Persist immutable `quality_reports`, update only the matching current content variant, and treat
  fresh duplicate deliveries as already in progress rather than failures.
- Publish and seed Quality Checker prompt `1.0.0` under ID
  `25000000-0000-4000-8000-000000000005`.
- Let content editors start the first check from either CONT-04 or QUAL-01. Poll while work is active,
  automatically select only current passing versions, and keep submit-review disabled otherwise.
- Add a global account menu showing the current user and enterprise, with explicit actions to switch
  enterprise, switch account, and log out. Preserve the intended return path during switching.
- Keep technical identifiers behind optional technical-details disclosure; ordinary labels and actions
  use human-readable Chinese.

## Consequences

- The existing generation -> quality -> review workflow is executable end to end from the UI.
- A failed or revised quality decision remains visible and requires editing plus a new check.
- Logging out revokes the server session and clears authentication cookies before returning to login.
- Switching enterprise continues to use the existing tenant-selector contract and active-membership
  checks; switching account first revokes the current session.
- No public API path, event version, state enum, database table, or migration is added.

## Verification

- Production builds pass for Web, API, and AI Worker under Node 22 and pnpm 10.
- Quality Checker and other Skills pass schema and runtime tests.
- Worker tests validate generation and quality event inputs.
- Playwright covers first check, recheck, passing-only review submission, logout, account switching,
  enterprise switching, session-expiry messaging, mobile access, and permission guards.
