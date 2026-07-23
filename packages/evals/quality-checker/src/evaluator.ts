import { QUALITY_CHECKER_OUTPUT_SCHEMA } from '@geo-content-os/contracts/skills';
import {
  QUALITY_CHECKER_CONTRACT_V1,
  type QualityCheckerFewShot,
} from '@geo-content-os/skills/quality-checker';
import { SchemaGuard } from '@geo-content-os/skills/runtime';
import { isDeepStrictEqual } from 'node:util';
import type {
  QualityCheckerEvalGate,
  QualityCheckerEvalManifest,
  QualityCheckerEvalMetrics,
  QualityCheckerEvalReport,
  QualityCheckerEvalThresholds,
} from './types.js';

interface EvalInput {
  readonly fact_results: readonly {
    readonly claim_key: string;
    readonly risk_level: string;
    readonly verdict: string;
  }[];
  readonly geo_result: { readonly scores: Readonly<Record<string, number>> };
  readonly safety_policy: { readonly max_warnings_for_pass: number };
}

export function evaluateQualityChecker(
  manifest: QualityCheckerEvalManifest,
  cases: readonly QualityCheckerFewShot[] = QUALITY_CHECKER_CONTRACT_V1.fewShots,
  evaluatedAt?: string,
): QualityCheckerEvalReport {
  if (
    cases.length !== manifest.caseIds.length ||
    cases.some((item, index) => item.id !== manifest.caseIds[index])
  )
    throw new TypeError('Evaluation cases do not match the versioned manifest');
  const guard = new SchemaGuard();
  const counts = { decision: 0, expected: 0, geo: 0, hard: 0, schema: 0 };
  for (const item of cases) {
    if (guard.check(QUALITY_CHECKER_OUTPUT_SCHEMA, item.output).valid) counts.schema += 1;
    if (decisionGate(item)) counts.decision += 1;
    if (expectedBehavior(item)) counts.expected += 1;
    if (
      isDeepStrictEqual(
        item.output.data.geo_scores,
        (item.input as unknown as EvalInput).geo_result.scores,
      )
    )
      counts.geo += 1;
    if (hardRules(item)) counts.hard += 1;
  }
  const metrics: QualityCheckerEvalMetrics = Object.freeze({
    caseCount: cases.length,
    decisionGate: ratio(counts.decision, cases.length),
    expectedBehavior: ratio(counts.expected, cases.length),
    geoIntegrity: ratio(counts.geo, cases.length),
    hardRule: ratio(counts.hard, cases.length),
    schemaValidity: ratio(counts.schema, cases.length),
  });
  const gates = Object.freeze(buildGates(metrics, manifest.thresholds));
  return Object.freeze({
    datasetVersion: manifest.datasetVersion,
    evaluatedAt: timestamp(evaluatedAt),
    gates,
    metrics,
    passed: gates.every((gate) => gate.passed),
    schemaVersion: 'quality-checker-eval-report@1',
    skillVersion: '1.0.0',
  });
}

function decisionGate(item: QualityCheckerFewShot): boolean {
  const input = item.input as unknown as EvalInput;
  const blocks = item.output.data.issues.filter((issue) => issue.severity === 'BLOCK').length;
  const warnings = item.output.data.issues.filter((issue) => issue.severity === 'WARN').length;
  const expected =
    blocks > 0 ? 'block' : warnings > input.safety_policy.max_warnings_for_pass ? 'revise' : 'pass';
  return (
    item.output.data.decision === expected &&
    (expected === 'block') ===
      item.output.blockers.some((blocker) => blocker.code === 'POLICY_BLOCK')
  );
}
function hardRules(item: QualityCheckerFewShot): boolean {
  const input = item.input as unknown as EvalInput;
  return input.fact_results.every(
    (fact) =>
      !(
        (fact.risk_level === 'high' || fact.risk_level === 'critical') &&
        (fact.verdict === 'unsupported' || fact.verdict === 'conflicted')
      ) ||
      item.output.data.issues.some(
        (issue) =>
          issue.severity === 'BLOCK' &&
          issue.category === 'fact' &&
          issue.location === `claim:${fact.claim_key}`,
      ),
  );
}
function expectedBehavior(item: QualityCheckerFewShot): boolean {
  if (item.id === 'clean-content-positive')
    return item.output.data.decision === 'pass' && item.output.data.issues.length === 0;
  if (item.id === 'wechat-title-hard-limit-negative')
    return (
      item.output.data.decision === 'block' &&
      item.output.data.issues.some(
        (issue) => issue.category === 'format' && issue.severity === 'BLOCK',
      )
    );
  if (item.id === 'warning-threshold-boundary')
    return (
      item.output.data.decision === 'revise' &&
      item.output.data.issues.filter((issue) => issue.severity === 'WARN').length === 6
    );
  return false;
}
function buildGates(
  metrics: QualityCheckerEvalMetrics,
  thresholds: QualityCheckerEvalThresholds,
): QualityCheckerEvalGate[] {
  return [
    gate('decisionGateMinimum', metrics.decisionGate, thresholds),
    gate('expectedBehaviorMinimum', metrics.expectedBehavior, thresholds),
    gate('geoIntegrityMinimum', metrics.geoIntegrity, thresholds),
    gate('hardRuleMinimum', metrics.hardRule, thresholds),
    gate('schemaValidityMinimum', metrics.schemaValidity, thresholds),
  ];
}
function gate(
  name: keyof QualityCheckerEvalThresholds,
  actual: number,
  thresholds: QualityCheckerEvalThresholds,
): QualityCheckerEvalGate {
  return Object.freeze({
    actual,
    gate: name,
    passed: actual >= thresholds[name],
    threshold: thresholds[name],
  });
}
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(12));
}
function timestamp(value?: string): string {
  if (value === undefined) return new Date().toISOString();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value)
    throw new TypeError('Evaluation timestamp must be a canonical ISO timestamp');
  return value;
}
