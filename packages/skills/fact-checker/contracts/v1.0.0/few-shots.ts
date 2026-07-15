import type { FactCheckerOutput } from '@geo-content-os/contracts/skills';

const VERSION_ID = '10000000-0000-4000-8000-000000000063';
const VARIANT_ID = '20000000-0000-4000-8000-000000000063';
const SOURCE_ID = '30000000-0000-4000-8000-000000000063';
const CHUNK_ID = '40000000-0000-4000-8000-000000000063';
const RUN_ID = '50000000-0000-4000-8000-000000000063';
const PROMPT_ID = '60000000-0000-4000-8000-000000000063';
const HASH = 'a'.repeat(64);

export interface FactCheckerFewShot {
  readonly id: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: FactCheckerOutput;
  readonly purpose: 'boundary' | 'negative' | 'positive';
  readonly toolResults: readonly Readonly<Record<string, unknown>>[];
}

function input(claimKey: string, claimText: string, riskLevel: string) {
  return Object.freeze({
    claims: Object.freeze([
      Object.freeze({ claim_key: claimKey, claim_text: claimText, risk_level: riskLevel }),
    ]),
    content_version: Object.freeze({
      content: Object.freeze({ blocks: [] }),
      content_hash: HASH,
      content_version_id: VERSION_ID,
      variant_id: VARIANT_ID,
    }),
    risk_policy: Object.freeze({
      human_review_levels: Object.freeze(['high', 'critical']),
      require_verified_for_high_risk: true,
    }),
    search_policy: Object.freeze({
      top_k: 5,
      trust_levels: Object.freeze(['verified', 'normal']),
    }),
  });
}

function output(
  result: FactCheckerOutput['data']['results'][number],
  overallDecision: FactCheckerOutput['data']['overall_decision'],
): FactCheckerOutput {
  return Object.freeze({
    blockers: Object.freeze(
      overallDecision === 'block' ? [{ code: 'HIGH_RISK_UNGROUNDED', message: result.reason }] : [],
    ),
    citations: Object.freeze(
      result.evidences.map((evidence) => ({
        chunk_id: evidence.chunk_id,
        quote_text: evidence.quote_text,
        source_id: SOURCE_ID,
      })),
    ),
    data: Object.freeze({ overall_decision: overallDecision, results: Object.freeze([result]) }),
    skill_name: 'fact-checker',
    skill_version: '1.0.0',
    status: 'success',
    trace: Object.freeze({
      input_hash: HASH,
      prompt_version_id: PROMPT_ID,
      request_id: 'request-fact-checker-0063',
      run_id: RUN_ID,
    }),
    usage: Object.freeze({
      cost_cents: 6,
      input_tokens: 500,
      model_key: 'pro',
      output_tokens: 180,
      provider: 'mock',
    }),
    warnings: Object.freeze([]),
  });
}

export const FACT_CHECKER_FEW_SHOTS_V1: readonly FactCheckerFewShot[] = Object.freeze([
  Object.freeze({
    id: 'supported-date-positive',
    input: input('release-date', '产品 A 于 2025 年 9 月发布。', 'medium'),
    output: output(
      Object.freeze({
        claim_key: 'release-date',
        claim_text: '产品 A 于 2025 年 9 月发布。',
        confidence: 0.96,
        evidences: Object.freeze([
          Object.freeze({
            chunk_id: CHUNK_ID,
            confidence: 0.96,
            quote_text: '产品 A 于 2025 年 9 月发布。',
            support_level: 'supported',
          }),
        ]),
        reason: 'Authoritative source states the same release date.',
        rewrite_suggestion: null,
        risk_level: 'medium',
        verdict: 'supported',
      }),
      'pass',
    ),
    purpose: 'positive',
    toolResults: Object.freeze([
      Object.freeze({ chunk_id: CHUNK_ID, quote_text: '产品 A 于 2025 年 9 月发布。' }),
    ]),
  }),
  Object.freeze({
    id: 'unsupported-market-leader-negative',
    input: input('market-leader', '产品 A 市场占有率第一。', 'high'),
    output: output(
      Object.freeze({
        claim_key: 'market-leader',
        claim_text: '产品 A 市场占有率第一。',
        confidence: 0.98,
        evidences: Object.freeze([]),
        reason: 'No authoritative evidence supports the market leadership claim.',
        rewrite_suggestion: '删除市场第一表述，或补充权威统计来源及统计口径。',
        risk_level: 'high',
        verdict: 'unsupported',
      }),
      'block',
    ),
    purpose: 'negative',
    toolResults: Object.freeze([]),
  }),
  Object.freeze({
    id: 'outdated-capability-boundary',
    input: input('current-feature', '产品 A 当前支持功能 B。', 'high'),
    output: output(
      Object.freeze({
        claim_key: 'current-feature',
        claim_text: '产品 A 当前支持功能 B。',
        confidence: 0.91,
        evidences: Object.freeze([
          Object.freeze({
            chunk_id: CHUNK_ID,
            confidence: 0.91,
            quote_text: '功能 B 的支持有效期截至 2025 年 12 月 31 日。',
            support_level: 'outdated',
          }),
        ]),
        reason: 'The evidence expired before the current content date.',
        rewrite_suggestion: '改为历史表述，并标注证据有效期截至 2025 年 12 月 31 日。',
        risk_level: 'high',
        verdict: 'outdated',
      }),
      'revise',
    ),
    purpose: 'boundary',
    toolResults: Object.freeze([
      Object.freeze({
        chunk_id: CHUNK_ID,
        quote_text: '功能 B 的支持有效期截至 2025 年 12 月 31 日。',
      }),
    ]),
  }),
]);
