import type { BrandProfile, PlatformCode } from '@geo-content-os/contracts';
import type {
  QualityCheckerData,
  QualityDecision,
  QualityIssue,
} from '@geo-content-os/contracts/skills';

import { QualityPipelineError } from './quality-pipeline.errors.js';
import type { QualityFactInput } from './quality-pipeline.types.js';

const CATEGORIES = new Set([
  'fact',
  'brand',
  'compliance',
  'format',
  'duplicate',
  'readability',
  'security',
]);
const SEVERITIES = new Set(['BLOCK', 'WARN', 'INFO']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TITLE_LIMITS: Readonly<Record<PlatformCode, number>> = Object.freeze({
  baijiahao: 40,
  douyin: 80,
  official_site: 60,
  toutiao: 50,
  wechat_mp: 64,
  xiaohongshu: 20,
  zhihu: 80,
});

export function applyRequiredQualityPolicy(input: {
  readonly assessment: QualityCheckerData;
  readonly brand: BrandProfile;
  readonly content: Readonly<Record<string, unknown>>;
  readonly factResults: readonly QualityFactInput[];
  readonly maxWarningsForPass: number;
  readonly platformCode: PlatformCode;
}): Readonly<{ decision: QualityDecision; issues: readonly QualityIssue[]; score: number }> {
  validateAssessment(input.assessment);
  const issues = [...input.assessment.issues];
  addFactBlockers(issues, input.factResults);
  addTitleBlocker(issues, input.content, input.platformCode);
  addBrandBlockers(issues, input.content, input.brand);
  const deduplicated = deduplicateIssues(issues);
  const decision = gateDecision(deduplicated, input.maxWarningsForPass);
  return Object.freeze({
    decision,
    issues: Object.freeze(deduplicated),
    score: input.assessment.score,
  });
}

function addFactBlockers(issues: QualityIssue[], facts: readonly QualityFactInput[]): void {
  for (const fact of facts) {
    if (
      !['high', 'critical'].includes(fact.risk_level) ||
      !['unsupported', 'conflicted'].includes(fact.verdict)
    ) {
      continue;
    }
    issues.push(
      Object.freeze({
        category: 'fact',
        citation_ids: Object.freeze([...fact.citation_ids]),
        location: `claim:${fact.claim_key}`,
        message:
          fact.verdict === 'unsupported'
            ? 'High-risk claim has no supporting evidence.'
            : 'High-risk claim has conflicting evidence.',
        rule_id: `fact.high_risk.${fact.verdict}`,
        severity: 'BLOCK',
        suggestion: 'Remove the claim or resolve it with authoritative evidence before review.',
      }),
    );
  }
}

function addTitleBlocker(
  issues: QualityIssue[],
  content: Readonly<Record<string, unknown>>,
  platformCode: PlatformCode,
): void {
  const title = content['title'];
  const contentPlatform = content['platform_code'];
  if (contentPlatform !== platformCode) {
    issues.push(
      blockIssue(
        'format.platform.mismatch',
        'format',
        'platform_code',
        'Platform code does not match the Variant.',
      ),
    );
  }
  if (typeof title !== 'string') {
    issues.push(
      blockIssue('format.title.required', 'format', 'title', 'Content title is required.'),
    );
    return;
  }
  const limit = TITLE_LIMITS[platformCode];
  if ([...title].length > limit) {
    issues.push(
      blockIssue(
        `${platformCode}.title.max_length`,
        'format',
        'title',
        `Title exceeds the ${platformCode} hard limit of ${limit} characters.`,
      ),
    );
  }
}

function addBrandBlockers(
  issues: QualityIssue[],
  content: Readonly<Record<string, unknown>>,
  brand: BrandProfile,
): void {
  const text = flattenContentText(content).toLocaleLowerCase('und');
  for (const banned of brand.banned) {
    if (!text.includes(banned.toLocaleLowerCase('und'))) continue;
    issues.push(
      blockIssue(
        'brand.banned_phrase',
        'brand',
        null,
        `Content contains a banned brand phrase: ${banned}`,
      ),
    );
  }
}

function validateAssessment(assessment: QualityCheckerData): void {
  if (!Number.isFinite(assessment.score) || assessment.score < 0 || assessment.score > 100) {
    invalid('Quality score is invalid');
  }
  if (!['pass', 'revise', 'block'].includes(assessment.decision)) {
    invalid('Quality decision is invalid');
  }
  if (!Array.isArray(assessment.issues) || assessment.issues.length > 1_000) {
    invalid('Quality issues are invalid');
  }
  for (const issue of assessment.issues) validateIssue(issue);
}

function validateIssue(issue: QualityIssue): void {
  if (!CATEGORIES.has(issue.category) || !SEVERITIES.has(issue.severity)) {
    invalid('Quality issue category or severity is invalid');
  }
  if (issue.rule_id.trim().length === 0 || issue.rule_id.length > 160) {
    invalid('Quality issue rule_id is invalid');
  }
  if (issue.message.trim().length === 0 || issue.message.length > 4_000) {
    invalid('Quality issue message is invalid');
  }
  if (
    issue.location !== null &&
    (issue.location.trim().length === 0 || issue.location.length > 500)
  ) {
    invalid('Quality issue location is invalid');
  }
  if (
    issue.suggestion !== null &&
    (issue.suggestion.trim().length === 0 || issue.suggestion.length > 4_000)
  ) {
    invalid('Quality issue suggestion is invalid');
  }
  if (
    new Set(issue.citation_ids).size !== issue.citation_ids.length ||
    issue.citation_ids.some((id) => !UUID_PATTERN.test(id))
  ) {
    invalid('Quality issue citation_ids are invalid');
  }
}

function gateDecision(
  issues: readonly QualityIssue[],
  maxWarningsForPass: number,
): QualityDecision {
  if (issues.some((issue) => issue.severity === 'BLOCK')) return 'block';
  const warnings = issues.filter((issue) => issue.severity === 'WARN').length;
  return warnings > maxWarningsForPass ? 'revise' : 'pass';
}

function deduplicateIssues(issues: readonly QualityIssue[]): QualityIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.rule_id}:${issue.category}:${issue.location ?? ''}:${issue.severity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function blockIssue(
  ruleId: string,
  category: 'brand' | 'format',
  location: string | null,
  message: string,
): QualityIssue {
  return Object.freeze({
    category,
    citation_ids: Object.freeze([]),
    location,
    message,
    rule_id: ruleId,
    severity: 'BLOCK',
    suggestion: 'Correct the blocking issue and run the quality pipeline again.',
  });
}

function flattenContentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flattenContentText).join('\n');
  if (!value || typeof value !== 'object') return '';
  return Object.values(value).map(flattenContentText).join('\n');
}

function invalid(message: string): never {
  throw new QualityPipelineError('QUALITY_EVALUATION_INVALID', message);
}
