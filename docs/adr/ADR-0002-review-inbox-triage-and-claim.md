# ADR-0002: Review inbox triage and claim correction

- Status: accepted
- Date: 2026-07-16
- Scope: T089 / REV-01

## Context

The frozen REV-01 page requires risk, due time, claimant, filtering, and a claim action. The executable ReviewInbox contract and `review_snapshots` migration exposed none of risk, due time, or claim ownership, so the page could not implement those requirements without fabricating state.

## Decision

- Add nullable `risk_level`, `due_at`, `claimed_by`, and `claimed_at` columns to `review_snapshots` in migration `0024_review_inbox_claim`.
- Add `POST /review-snapshots/{id}/claim` with `key+version`, `reviewer_or_admin`, and `review.decide` guards.
- Require the claimant to provide `risk_level` and a future `due_at`; a successful claim records the current server-side user, increments `version`, and writes an audit event.
- Preserve workspace isolation through the existing `scopeForSnapshot` and `has_project_scope_access` checks.
- Extend the review inbox response and filters with claim and risk fields.

This correction raises the executable API total from 114 to 115. Frozen DOCX files remain unchanged and read-only; this ADR is the correction record for implementation and T141 OpenAPI verification.
