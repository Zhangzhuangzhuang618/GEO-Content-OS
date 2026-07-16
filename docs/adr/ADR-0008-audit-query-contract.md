# ADR-0008: Tenant audit query contract

- Status: accepted
- Date: 2026-07-16
- Scope: T101 / SET-04

## Context

The frozen API baseline already lists tenant-scoped `GET /audit-events`, and SET-04 depends on it, but no executable contract, OpenAPI operation, or API implementation existed. The T101 file range listed only Web files, which made the page impossible to implement without an undocumented endpoint dependency.

## Decision

- Implement the existing `GET /audit-events` endpoint without changing the executable API total of 121.
- Require `audit.read`; the frozen role matrix grants it only to `tenant_owner`.
- Scope every query to the active server-side tenant context. Never accept a tenant identifier from the client.
- Support cursor pagination and exact filters for actor, action, resource, request ID, and an inclusive UTC time range.
- Return actor, action, resource, before/after, request ID, IP, and time. Apply defensive sensitive-data redaction before serialization even when stored audit JSON was already redacted.
- Keep audit history append-only through the existing database trigger. The API exposes no mutation endpoint.
- Export only the currently loaded, filtered rows as a local CSV; do not add another API endpoint or asynchronous job.
- Keep the frozen DOCX files unchanged and read-only.

Contracts, generated OpenAPI, API integration tests, the SET-04 page, and `PROJECT_CONTEXT.md` are the executable correction surface. No database migration is required.
