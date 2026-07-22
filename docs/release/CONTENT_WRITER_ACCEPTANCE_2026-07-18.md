# Content Writer publish-grade acceptance — 2026-07-18

## Scope

- Model: `deepseek-v4-pro`
- Prompt: `25000000-0000-4000-8000-000000000002` (`1.1.0`)
- Topic: 广州搬家公司怎么选
- Brand: 广州志远搬家服务有限公司
- Platforms: master, official_site, zhihu, xiaohongshu
- Publication: none; local generation only

## User-confirmed first-party facts

- As of 2026-07-18, the company reports owning 30+ large vehicles.
- The company reports employing dozens of in-house movers.
- The company reports that those movers are formal employees with social insurance.
- These facts are not treated as independent public evidence. Public release should attach a
  redacted vehicle/registration summary and redacted social-insurance proof summary.

## Automated result

| Content | Effective characters | Blocks | Headings | Lists | Gate |
|---|---:|---:|---:|---:|---|
| master | 1709 | 19 | 7 | 1 | pass |
| official_site | 1383 | 21 | 7 | 1 | pass |
| zhihu | 1222 | 15 | 7 | 1 | pass |
| xiaohongshu | 503 | 12 | 5 | 2 | pass |

The generated content used answer-first structure, vehicle/personnel/process decision criteria,
applicable-scenario boundaries, checklists, FAQ or platform-specific metadata, and explicit
first-party attribution. It did not use a competitor ranking, fake authority, fabricated customer
review, or unsupported comparative claim.

## Human review correction

The first accepted sample still inferred training and responsibility consequences from formal
employment and social-insurance status, and included an overconfident “基本不会踩大坑” sentence.
Prompt and deterministic risk patterns were tightened after this review. The final contract now
forbids inferring training, skill, quality, legal result, customer outcome, or competitive
superiority from vehicle ownership or employment attributes alone.

## Known publication boundary

This acceptance confirms runtime wiring, model routing, schema repair, structure, length, and fact
attribution. It does not turn user-confirmed private facts into public evidence. Before real
publication, attach documentary proof, run Fact Checker and Quality Checker, and complete human
review.
