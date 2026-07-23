# ADR-0010: AI Worker runtime and account-targeted generation

- Status: accepted
- Date: 2026-07-16
- Scope: post-freeze runtime correction

## Context

The frozen implementation contained the DeepSeek adapter, Content Writer Skill, generation state
machine, Outbox Relay, Redis queue mapping, platform account APIs, and Docker service names, but no
AI Worker process connected them. The Compose `ai-worker` service ran only a generic health
placeholder. A generation request could therefore remain queued indefinitely after the API returned
202.

The Content Writer Skill contract returns one master item and all requested platform variants in one
validated result. The existing generation database model keeps one master run plus one derived run
per platform for status and provenance. The previous cost estimator incorrectly treated these
derived runs as separate provider requests.

## Decision

- Add a real AI Worker process that consumes `content.package.generation_requested.v1` from
  `geo-ai`, executes `ContentWriterSkill` through `SkillRunner`, persists master and variant content,
  finalizes generation runs, and records provider usage.
- Support `AI_MODEL_DRIVER=mock|deepseek`. Mock is deterministic and permitted only outside
  production. DeepSeek uses the existing OpenAI-compatible adapter and environment configuration.
- Inject server-owned Skill identity and trace fields into the model messages. Tenant identity and
  credentials remain server-only.
- Execute one Content Writer provider call for a package and reuse its validated variant set for the
  existing derived platform runs. On a process retry after the master succeeded, one replacement
  call may be made to reconstruct missing variants. The cost estimator therefore reports one normal
  provider request.
- Retry content generation queue jobs up to five times with exponential backoff.
- When `CONTENT_REQUIRE_PLATFORM_ACCOUNTS=true`, require exactly one active account for every
  requested platform in the package workspace. Persist that account on the variant through
  `content_variants.platform_account_id`.
- Supply only non-secret account metadata to the writer under
  `brief.constraints.target_accounts_by_code`: account ID, display name, provider account ID,
  timezone, and declared capabilities. Credential ciphertext, bearer tokens, and API keys never
  enter events, prompts, content, logs, or API responses.
- Keep `CONTENT_REQUIRE_PLATFORM_ACCOUNTS` disabled by default in legacy tests and enable it by
  default in Compose and `.env.example`.
- Use server-built strategy and platform-rule snapshots as authorized tool fallbacks when the same
  immutable version is not present in a fresh local database.
- Replace incomplete selective runtime copies in the API Dockerfile with the complete built
  workspace. Image minimization is deferred until it can preserve all workspace runtime
  dependencies.
- Keep the frozen DOCX files unchanged and record this executable correction in this ADR.

## Configuration

Real model mode requires `AI_MODEL_DRIVER=deepseek`, `DEEPSEEK_API_KEY`,
`DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL_KEY`, and `DEEPSEEK_PROVIDER_MODEL_ID`. Timeout, retry, output
token, and policy-to-model settings remain configurable through `.env.example`.

Platform API credentials remain encrypted platform-account data managed by the existing account
API. `PUBLISHING_CREDENTIAL_KEY_BASE64` is required before API-mode accounts can be stored.

## Consequences

- Starting Compose now creates a healthy, queue-consuming AI Worker rather than a placeholder.
- A single package still supports at most one target account per platform because
  `content_variants` has one row per platform. If a workspace has multiple active accounts for the
  same platform, generation fails explicitly until one is disabled. Multi-account variants require
  a separate product contract and are not inferred here.
- A missing model rate card does not block generation; usage is recorded with zero monetary cost
  until an effective matching card exists. Token usage remains exact.

## Verification

- Worker and Skills type checks and unit tests.
- Empty-database migration through migration 0031.
- Docker image build and health checks for API, Outbox Relay, and AI Worker.
- Local Mock queue E2E: Outbox published, one package generated, seven account-bound variants
  generated, eight logical runs succeeded, and one estimated/settled model usage lifecycle written.
