# ADR-0011: Publish-grade content generation

- Status: accepted
- Date: 2026-07-18
- Scope: user-authorized post-freeze content quality correction

## Context

The frozen Content Writer contract validated JSON shape, citations, locks, and requested platform
coverage, but it did not validate editorial completeness. Its positive few-shot contained a single
sentence. The AI Worker also used one configured adapter, did not load the published
`prompt_versions` record, routed fast, balanced, and quality policies to the same model, and allowed
a schema-valid short placeholder to become a generated content version.

Evaluation against the supplied Guangzhou moving-company GEO report and 179-URL workbook found a
repeatable useful structure: direct answer, explicit decision criteria, scenario fit, evidence
boundaries, risk guidance, actionable checklist, and stable entity attributes. Unsupported rankings,
invented authority, disguised third-party recommendations, and duplicate content-farm wording are
not accepted as quality patterns.

## Decision

- Keep Content Writer input/output schema version 1 and the existing title, summary, and block-based
  editor representation.
- Publish prompt version `1.1.1` under ID `25000000-0000-4000-8000-000000000003`. Version 1.1.1
  supersedes the acceptance baseline 1.1.0 by prohibiting unsupported inferences from fleet and
  employment attributes. The AI Worker
  loads the referenced published prompt and combines it with the code-owned safety and platform
  contract. A missing or wrong-skill prompt fails closed.
- Replace the one-sentence positive example with a complete answer-first example containing
  sections, a decision checklist, evidence boundaries, and a conclusion.
- Route fast and balanced to `deepseek-v4-flash` and quality to `deepseek-v4-pro`. The worker owns a
  model-keyed adapter map instead of a single adapter.
- Increase the runtime output budget to 32,768 tokens and the provider timeout to 300 seconds for
  multi-platform long-form JSON output.
- Add deterministic per-platform semantic gates for effective character count, block count,
  headings, lists, duplicate blocks, placeholders, and unsupported authority/absolute claims.
- Fast mode returns the first schema-valid result. Balanced and quality mode perform one complete,
  issue-directed rewrite when the first result misses their thresholds. If the rewritten result still
  misses the threshold, generation fails with `CONTENT_QUALITY_INSUFFICIENT` instead of persisting a
  thin article.
- Keep JSON syntax and schema repair in `SkillRunner`. The DeepSeek transport adapter returns JSON
  mode text without pre-parsing it, so the existing one-pass repair can correct malformed provider
  output instead of being bypassed by an adapter-level failure.
- Add `model_policy` to new generation events. Consumers treat its absence as `balanced` so queued
  pre-change events remain processable.
- Treat user-confirmed private enterprise facts as attributed first-party facts. They may guide
  content, but they cannot be represented as public independent evidence. Comparative superiority,
  customer outcomes, rankings, and other unsupported implications remain prohibited.

## Consequences

- Balanced and quality generations may use two provider calls. Cost estimates and UI copy must not
  promise one call for these policies.
- Selecting all seven platforms can produce a large JSON response; 32,768 output tokens is the
  supported local default.
- Content with insufficient evidence can still provide general decision guidance, but must disclose
  the evidence boundary.
- Platform guidance is based on public rules and observable editorial formats, not claims about
  secret recommendation or AI-crawler algorithms.

## Verification

- Content Writer prompt/schema tests and semantic quality-gate tests.
- AI Worker event, model routing, prompt loading, and generation tests.
- API generation integration tests including `model_policy` propagation.
- Local DeepSeek acceptance generation using the Guangzhou Zhiyuan facts, followed by structural,
  factual, and platform-specific review before any real publication.
