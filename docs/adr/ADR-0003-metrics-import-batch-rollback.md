# ADR-0003: Metrics import batch rollback endpoint

- Status: accepted
- Date: 2026-07-16
- Scope: T095 / ANL-02

## Context

The frozen ANL-02 page requires rollback of a completed metrics import batch. The database and `MetricsImportService.rollback()` already preserve append-only metric rows and exclude rolled-back batches from analytics by changing `import_jobs.status` to `rolled_back`, but the executable Analytics API exposed no rollback route.

## Decision

- Add `POST /metrics/import-jobs/{id}/rollback` guarded by `analyst_or_admin` and `analytics.read`.
- Require `RollbackImportRequest.reason` and `Idempotency-Key`; use `key+body_hash` because `ImportJobView` has no public optimistic-lock version.
- Permit rollback only from `succeeded`; repeated delivery with the same key returns the stored response, while a new invalid transition returns `STATE_TRANSITION_INVALID`.
- Keep `metric_records` append-only. Rollback changes only the batch status, and analytics queries already include records only when the linked batch remains `succeeded`.
- Record the reason in the required audit event. No database migration is needed.

This correction raises the executable API total from 115 to 116. Frozen DOCX files remain unchanged and read-only; this ADR is the correction record for implementation and T141 OpenAPI verification.
