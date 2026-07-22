# ADR-0012: Repair empty Content Writer citation mappings

- Status: accepted
- Date: 2026-07-18
- Scope: user-authorized defect correction after ADR-0011

## Context

A source-free Brief successfully invoked DeepSeek and returned schema-valid content, but the model
placed a general statement in `citation_map` with an empty `citation_ids` array. The JSON Schema
allowed the empty array while the post-schema semantic validator rejected it. Because that rejection
happened after `SkillRunner` completed, neither schema repair nor the publish-grade quality rewrite
could run. The master run failed and all platform variants were projected as failed.

The published prompt already allowed advice, analysis, and clearly attributed first-party statements
without independent citations. Those statements should be omitted from `citation_map`, not represented
by an empty evidence mapping.

## Decision

- Publish Content Writer prompt `1.1.2` under ID
  `25000000-0000-4000-8000-000000000004`.
- Restrict output `citation_map[*].citation_ids` to at least one UUID. This is backward-compatible
  with every output previously accepted by the semantic validator.
- Require an empty `citation_map` when the run has no supplied citations. Advice, analysis, and
  first-party statements without independent evidence remain in visible content but not in the
  public-evidence mapping.
- Strengthen the single JSON repair instruction: it may remove unsupported optional entries but may
  not invent facts, identifiers, citations, or missing values.
- Keep the semantic validator as defense in depth against forged or out-of-scope citation IDs.

## Consequences

- The observed empty-array response now receives one bounded schema repair instead of immediately
  failing the content package.
- A model that fabricates a syntactically valid UUID is still rejected by semantic validation.
- Source-free articles can contain general decision guidance and attributed first-party information,
  but cannot claim independent public evidence.
- No database schema, public API, state machine, or queue event version changes are required.

## Verification

- Contract test rejects an empty `citation_ids` array at the exact output path.
- Content Writer test verifies repair from an empty mapping to source-free empty citation maps.
- Existing forged-citation, locked-block, JSON repair, runtime, and integration tests remain passing.
