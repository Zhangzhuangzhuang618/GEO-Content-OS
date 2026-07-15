import { FACT_CHECKER_OUTPUT_SCHEMA } from '@geo-content-os/contracts/skills';
import {
  FACT_CHECKER_CONTRACT_V1,
  type FactCheckerFewShot,
} from '@geo-content-os/skills/fact-checker';
import { SchemaGuard } from '@geo-content-os/skills/runtime';

import type {
  FactCheckerEvalGate,
  FactCheckerEvalManifest,
  FactCheckerEvalMetrics,
  FactCheckerEvalReport,
  FactCheckerEvalThresholds,
} from './types.js';

interface EvalInput {
  readonly claims: readonly {
    readonly claim_key: string;
    readonly claim_text: string;
    readonly risk_level: string;
  }[];
}

export function evaluateFactChecker(
  manifest: FactCheckerEvalManifest,
  cases: readonly FactCheckerFewShot[] = FACT_CHECKER_CONTRACT_V1.fewShots,
  evaluatedAt?: string,
): FactCheckerEvalReport {
  assertCases(manifest, cases);
  const guard = new SchemaGuard();
  const counts = { claims: 0, evidence: 0, expected: 0, risk: 0, quotes: 0, schemas: 0 };
  for (const item of cases) {
    if (guard.check(FACT_CHECKER_OUTPUT_SCHEMA, item.output).valid) counts.schemas += 1;
    if (claimCoverage(item)) counts.claims += 1;
    if (evidenceRule(item)) counts.evidence += 1;
    if (expectedBehavior(item)) counts.expected += 1;
    if (highRiskDecision(item)) counts.risk += 1;
    if (quoteIntegrity(item)) counts.quotes += 1;
  }
  const metrics: FactCheckerEvalMetrics = Object.freeze({
    caseCount: cases.length,
    claimCoverage: ratio(counts.claims, cases.length),
    evidenceRule: ratio(counts.evidence, cases.length),
    expectedBehavior: ratio(counts.expected, cases.length),
    highRiskDecision: ratio(counts.risk, cases.length),
    quoteIntegrity: ratio(counts.quotes, cases.length),
    schemaValidity: ratio(counts.schemas, cases.length),
  });
  const gates = Object.freeze(buildGates(metrics, manifest.thresholds));
  return Object.freeze({
    datasetVersion: manifest.datasetVersion,
    evaluatedAt: timestamp(evaluatedAt),
    gates,
    metrics,
    passed: gates.every((gate) => gate.passed),
    schemaVersion: 'fact-checker-eval-report@1',
    skillVersion: '1.0.0',
  });
}

function assertCases(manifest: FactCheckerEvalManifest, cases: readonly FactCheckerFewShot[]) {
  if (
    cases.length !== manifest.caseIds.length ||
    cases.some((item, index) => item.id !== manifest.caseIds[index])
  )
    throw new TypeError('Evaluation cases do not match the versioned manifest');
}

function claimCoverage(item: FactCheckerFewShot): boolean {
  const claims = (item.input as unknown as EvalInput).claims;
  return (
    item.output.data.results.length === claims.length &&
    claims.every((claim) =>
      item.output.data.results.some(
        (result) =>
          result.claim_key === claim.claim_key &&
          result.claim_text === claim.claim_text &&
          result.risk_level === claim.risk_level,
      ),
    )
  );
}

function evidenceRule(item: FactCheckerFewShot): boolean {
  return item.output.data.results.every((result) =>
    result.verdict === 'unsupported' ? result.evidences.length === 0 : result.evidences.length > 0,
  );
}

function quoteIntegrity(item: FactCheckerFewShot): boolean {
  return item.output.data.results.every((result) =>
    result.evidences.every((evidence) =>
      item.toolResults.some(
        (tool) =>
          tool['chunk_id'] === evidence.chunk_id &&
          typeof tool['quote_text'] === 'string' &&
          tool['quote_text'].includes(evidence.quote_text),
      ),
    ),
  );
}

function highRiskDecision(item: FactCheckerFewShot): boolean {
  const highUnsupported = item.output.data.results.some(
    (result) =>
      (result.risk_level === 'high' || result.risk_level === 'critical') &&
      result.verdict === 'unsupported',
  );
  return !highUnsupported || item.output.data.overall_decision === 'block';
}

function expectedBehavior(item: FactCheckerFewShot): boolean {
  const result = item.output.data.results[0]!;
  if (item.id === 'supported-date-positive') {
    return result.verdict === 'supported' && item.output.data.overall_decision === 'pass';
  }
  if (item.id === 'unsupported-market-leader-negative') {
    return result.verdict === 'unsupported' && item.output.data.overall_decision === 'block';
  }
  if (item.id === 'outdated-capability-boundary') {
    return result.verdict === 'outdated' && item.output.data.overall_decision === 'revise';
  }
  return false;
}

function buildGates(
  metrics: FactCheckerEvalMetrics,
  thresholds: FactCheckerEvalThresholds,
): FactCheckerEvalGate[] {
  return [
    gate('claimCoverageMinimum', metrics.claimCoverage, thresholds),
    gate('evidenceRuleMinimum', metrics.evidenceRule, thresholds),
    gate('expectedBehaviorMinimum', metrics.expectedBehavior, thresholds),
    gate('highRiskDecisionMinimum', metrics.highRiskDecision, thresholds),
    gate('quoteIntegrityMinimum', metrics.quoteIntegrity, thresholds),
    gate('schemaValidityMinimum', metrics.schemaValidity, thresholds),
  ];
}

function gate(
  name: keyof FactCheckerEvalThresholds,
  actual: number,
  thresholds: FactCheckerEvalThresholds,
): FactCheckerEvalGate {
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
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new TypeError('Evaluation timestamp must be a canonical ISO timestamp');
  }
  return value;
}
