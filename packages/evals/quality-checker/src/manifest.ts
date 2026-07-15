import { readFile } from 'node:fs/promises';
import type { QualityCheckerEvalManifest, QualityCheckerEvalThresholds } from './types.js';
const KEYS = [
  'decision_gate_minimum',
  'expected_behavior_minimum',
  'geo_integrity_minimum',
  'hard_rule_minimum',
  'schema_validity_minimum',
] as const;
export async function loadManifest(path: string): Promise<QualityCheckerEvalManifest> {
  return parseManifest(JSON.parse(await readFile(path, 'utf8')));
}
export function parseManifest(value: unknown): QualityCheckerEvalManifest {
  if (!record(value) || value['schema_version'] !== 'quality-checker-eval-manifest@1') invalid();
  const ids = value['case_ids'];
  const raw = value['thresholds'];
  if (
    typeof value['dataset_version'] !== 'string' ||
    !Array.isArray(ids) ||
    ids.length < 3 ||
    ids.some((id) => typeof id !== 'string' || !id) ||
    new Set(ids).size !== ids.length ||
    !record(raw) ||
    Object.keys(raw).length !== KEYS.length ||
    KEYS.some((key) => typeof raw[key] !== 'number')
  )
    invalid();
  const thresholds: QualityCheckerEvalThresholds = {
    decisionGateMinimum: number(raw['decision_gate_minimum']),
    expectedBehaviorMinimum: number(raw['expected_behavior_minimum']),
    geoIntegrityMinimum: number(raw['geo_integrity_minimum']),
    hardRuleMinimum: number(raw['hard_rule_minimum']),
    schemaValidityMinimum: number(raw['schema_validity_minimum']),
  };
  if (Object.values(thresholds).some((item) => !Number.isFinite(item) || item < 0 || item > 1))
    invalid();
  return Object.freeze({
    caseIds: Object.freeze([...ids] as string[]),
    datasetVersion: value['dataset_version'],
    schemaVersion: 'quality-checker-eval-manifest@1',
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
  throw new TypeError('Quality Checker evaluation manifest is invalid');
}
