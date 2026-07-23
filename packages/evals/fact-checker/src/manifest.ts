import { readFile } from 'node:fs/promises';

import type { FactCheckerEvalManifest, FactCheckerEvalThresholds } from './types.js';

const KEYS = [
  'claim_coverage_minimum',
  'evidence_rule_minimum',
  'expected_behavior_minimum',
  'high_risk_decision_minimum',
  'quote_integrity_minimum',
  'schema_validity_minimum',
] as const;

export async function loadManifest(path: string): Promise<FactCheckerEvalManifest> {
  return parseManifest(JSON.parse(await readFile(path, 'utf8')));
}

export function parseManifest(value: unknown): FactCheckerEvalManifest {
  if (!record(value) || value['schema_version'] !== 'fact-checker-eval-manifest@1') invalid();
  const ids = value['case_ids'];
  const raw = value['thresholds'];
  if (
    typeof value['dataset_version'] !== 'string' ||
    !Array.isArray(ids) ||
    ids.length < 3 ||
    ids.some((item) => typeof item !== 'string' || !item) ||
    new Set(ids).size !== ids.length ||
    !record(raw) ||
    Object.keys(raw).length !== KEYS.length ||
    KEYS.some((key) => typeof raw[key] !== 'number')
  )
    invalid();
  const thresholds: FactCheckerEvalThresholds = {
    claimCoverageMinimum: number(raw['claim_coverage_minimum']),
    evidenceRuleMinimum: number(raw['evidence_rule_minimum']),
    expectedBehaviorMinimum: number(raw['expected_behavior_minimum']),
    highRiskDecisionMinimum: number(raw['high_risk_decision_minimum']),
    quoteIntegrityMinimum: number(raw['quote_integrity_minimum']),
    schemaValidityMinimum: number(raw['schema_validity_minimum']),
  };
  if (Object.values(thresholds).some((item) => !Number.isFinite(item) || item < 0 || item > 1)) {
    invalid();
  }
  return Object.freeze({
    caseIds: Object.freeze([...ids] as string[]),
    datasetVersion: value['dataset_version'],
    schemaVersion: 'fact-checker-eval-manifest@1',
    thresholds: Object.freeze(thresholds),
  });
}

function number(value: unknown): number {
  if (typeof value !== 'number') invalid();
  return value;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function invalid(): never {
  throw new TypeError('Fact Checker evaluation manifest is invalid');
}
