# ADR-0005: Cost budget and provider reconciliation endpoints

- Status: accepted
- Date: 2026-07-16
- Scope: T097 / ANL-04

## Context

The frozen ANL-04 page requires budget viewing and reconciliation between the settled usage ledger and provider statements. The executable Analytics API exposed only cost breakdown and usage summary, while `CostQueryService.budget()` and `CostQueryService.reconcileProviders()` already implemented tenant-scoped budget calculation, effective-settlement filtering, provider aggregation, role authorization, and statement comparison.

## Decision

- Add `GET /analytics/costs/budget` for a workspace and calendar month. It reads the workspace budget policy and settled, non-reversed CNY ledger entries.
- Add side-effect-free `POST /analytics/costs/reconcile` because provider statement lines are structured request data. It compares request-scoped statement lines with settled, non-reversed provider totals and does not require an idempotency key.
- Do not persist provider statement lines and do not add a supplier invoice table. Reconciliation results are transient and the append-only `usage_ledger` remains the system cost fact source.
- Keep budget editing in SET-02 workspace settings. ANL-04 only displays budget status and links operators to the existing settings flow.
- Export the currently loaded cost view as deterministic CSV in the browser; no additional export job or endpoint is needed.
- Reuse the existing database schema. No migration or queue is required.

This correction raises the executable API total from 118 to 120. Frozen DOCX files remain unchanged and read-only; this ADR is the correction record for implementation and T141 OpenAPI verification.
