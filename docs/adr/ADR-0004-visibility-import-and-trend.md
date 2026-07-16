# ADR-0004: Visibility import and trend endpoints

- Status: accepted
- Date: 2026-07-16
- Scope: T096 / ANL-03

## Context

The frozen ANL-03 page requires manual entry, bulk import, and trend viewing. The executable Analytics API exposed only single observation creation, while `VisibilityService.importRows()` and `VisibilityService.trend()` already implemented atomic import, scoped aggregation, audit writes, and tenant/workspace authorization.

## Decision

- Add idempotent `POST /visibility-observations/import` for 1 to 1,000 JSON rows in one workspace. Imported rows may reference an existing evidence asset but do not embed screenshots.
- Add `GET /visibility-observations/trend` with workspace, date, optional platform, and normalized query-text filters.
- Keep screenshot upload on single-observation creation. The API decodes the image and `VisibilityService` writes the bytes to object storage before linking a `media_assets` screenshot record.
- Reuse the existing append-only `visibility_observations` and `media_assets` schema. No database migration or queue is required.

This correction raises the executable API total from 116 to 118. Frozen DOCX files remain unchanged and read-only; this ADR is the correction record for implementation and T141 OpenAPI verification.
