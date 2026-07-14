import type {
  QualityCheckerOutput,
  QualityIssue,
} from '../../../../contracts/src/skills/quality-checker/index.js';

const CONTENT_VERSION_ID = '10000000-0000-4000-8000-000000000069';
const VARIANT_ID = '20000000-0000-4000-8000-000000000069';
const BRAND_ID = '30000000-0000-4000-8000-000000000069';
const RULE_ID = '40000000-0000-4000-8000-000000000069';
const CITATION_ID = '50000000-0000-4000-8000-000000000069';
const RUN_ID = '60000000-0000-4000-8000-000000000069';
const PROMPT_ID = '70000000-0000-4000-8000-000000000069';
const HASH = 'd'.repeat(64);

const GEO_SCORES = Object.freeze({
  answerability: 84,
  entity: 82,
  evidence: 90,
  platform_fit: 88,
  question: 80,
  readability_safety: 86,
  total: 84.8,
});

export interface QualityCheckerFewShot {
  readonly id: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: QualityCheckerOutput;
  readonly purpose: 'boundary' | 'negative' | 'positive';
}

function input(title: string, maxWarningsForPass = 5, highRiskUnsupported = false) {
  return Object.freeze({
    brand_policy: Object.freeze({
      brand_profile_id: BRAND_ID,
      policy: Object.freeze({ banned_claims: [] }),
      version: 2,
    }),
    content_version: Object.freeze({
      content: Object.freeze({
        blocks: Object.freeze([]),
        platform_code: 'wechat_mp',
        title,
      }),
      content_hash: HASH,
      content_version_id: CONTENT_VERSION_ID,
      variant_id: VARIANT_ID,
    }),
    duplicate_matches: Object.freeze([]),
    fact_results: Object.freeze([
      Object.freeze({
        citation_ids: Object.freeze(highRiskUnsupported ? [] : [CITATION_ID]),
        claim_key: 'workflow-value',
        claim_text: '该系统支持内容流程追溯。',
        confidence: highRiskUnsupported ? 0.92 : 0.96,
        risk_level: highRiskUnsupported ? 'high' : 'medium',
        verdict: highRiskUnsupported ? 'unsupported' : 'supported',
      }),
    ]),
    geo_result: Object.freeze({ scores: GEO_SCORES }),
    platform_rules: Object.freeze({
      platform_code: 'wechat_mp',
      rules: Object.freeze({ title_max_length: 64 }),
      rules_hash: HASH,
      version_id: RULE_ID,
    }),
    safety_policy: Object.freeze({
      block_on_data_leakage: true,
      block_on_injection: true,
      max_warnings_for_pass: maxWarningsForPass,
    }),
  });
}

function issue(index: number, severity: 'BLOCK' | 'WARN'): QualityIssue {
  return Object.freeze({
    category: severity === 'BLOCK' ? ('format' as const) : ('readability' as const),
    citation_ids: Object.freeze([]),
    location: severity === 'BLOCK' ? 'title' : `blocks[${index}]`,
    message:
      severity === 'BLOCK'
        ? '微信公众号标题超过 64 字硬限制。'
        : `段落 ${index + 1} 可进一步缩短。`,
    rule_id: severity === 'BLOCK' ? 'wechat_mp.title.max_length' : 'readability.paragraph.length',
    severity,
    suggestion: severity === 'BLOCK' ? '在不删除事实或引用的前提下缩短标题。' : '拆分长段落。',
  });
}

const HIGH_RISK_FACT_ISSUE: QualityIssue = Object.freeze({
  category: 'fact',
  citation_ids: Object.freeze([]),
  location: 'claim:workflow-value',
  message: '高风险事实没有支持证据。',
  rule_id: 'fact.high_risk.unsupported',
  severity: 'BLOCK',
  suggestion: '删除该事实承诺，或补充权威证据并重新检查。',
});

function output(
  decision: 'block' | 'pass' | 'revise',
  issues: readonly QualityIssue[],
  score: number,
): QualityCheckerOutput {
  return Object.freeze({
    blockers: Object.freeze(
      decision === 'block'
        ? [{ code: 'POLICY_BLOCK', message: 'A frozen quality rule blocked this content.' }]
        : [],
    ),
    citations: Object.freeze([]),
    data: Object.freeze({ decision, geo_scores: GEO_SCORES, issues: Object.freeze(issues), score }),
    skill_name: 'quality-checker',
    skill_version: '1.0.0',
    status: 'success',
    trace: Object.freeze({
      input_hash: HASH,
      prompt_version_id: PROMPT_ID,
      request_id: 'request-quality-checker-0069',
      run_id: RUN_ID,
    }),
    usage: Object.freeze({
      cost_cents: 4,
      input_tokens: 380,
      model_key: 'flash',
      output_tokens: 140,
      provider: 'mock',
    }),
    warnings: Object.freeze([]),
  });
}

const LONG_WECHAT_TITLE =
  '这是一个用于验证微信公众号标题硬限制的企业级内容生产流程说明标题，长度明确超过六十四个字符且不得被静默截断或忽略，同时继续补充无关标题文字以确保稳定超过冻结上限';
const SIX_WARNINGS = Object.freeze(Array.from({ length: 6 }, (_, index) => issue(index, 'WARN')));

export const QUALITY_CHECKER_FEW_SHOTS_V1: readonly QualityCheckerFewShot[] = Object.freeze([
  Object.freeze({
    id: 'clean-content-positive',
    input: input('企业 GEO 内容生产流程'),
    output: output('pass', [], 92),
    purpose: 'positive',
  }),
  Object.freeze({
    id: 'wechat-title-hard-limit-negative',
    input: input(LONG_WECHAT_TITLE, 5, true),
    output: output('block', [issue(0, 'BLOCK'), HIGH_RISK_FACT_ISSUE], 35),
    purpose: 'negative',
  }),
  Object.freeze({
    id: 'warning-threshold-boundary',
    input: input('企业 GEO 内容生产流程', 5),
    output: output('revise', SIX_WARNINGS, 72),
    purpose: 'boundary',
  }),
]);
