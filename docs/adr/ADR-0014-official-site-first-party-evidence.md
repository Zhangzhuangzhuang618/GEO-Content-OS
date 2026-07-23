# ADR-0014: Official-site first-party evidence policy

## Decision

A published `brand_profile` is an enterprise-approved first-party source. Official-site content may
state matching operational facts without a public URL or an additional official-confirmation step.
The quality checker must not create a citation issue solely because such content has an empty
`citation_map`.

Public or documentary evidence remains required for licences, certifications, awards, regulated
claims, third-party statistics, comparative claims, customer outcomes, and statements that extend
beyond the published brand profile. First-party facts remain internally traceable and must never be
represented as independent third-party evidence.

## Consequences

- Official-site platform rules version 1.1.0 records the exemption and its boundaries.
- Publishing a platform-rule version retires the previously published version for that platform;
  the database enforces at most one published rule per platform.
- Evidence scoring recognizes the published brand profile for official-site content.
- Existing immutable reports remain in history; rechecking creates a report under the new rule.
