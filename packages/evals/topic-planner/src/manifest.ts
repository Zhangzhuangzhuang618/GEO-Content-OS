import { readFile } from 'node:fs/promises';

import type { TopicPlannerEvalManifest, TopicPlannerEvalThresholds } from './types.js';

const KEYS = [
  'brief_linkage_minimum',
  'evidence_integrity_minimum',
  'expected_behavior_minimum',
  'no_evidence_safety_minimum',
  'scope_compliance_minimum',
  'schema_validity_minimum',
] as const;

export async function loadManifest(path: string): Promise<TopicPlannerEvalManifest> {
  return parseManifest(JSON.parse(await readFile(path, 'utf8')));
}

export function parseManifest(value: unknown): TopicPlannerEvalManifest {
  if (!record(value) || value['schema_version'] !== 'topic-planner-eval-manifest@1') invalid();
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
  const thresholds: TopicPlannerEvalThresholds = {
    briefLinkageMinimum: number(raw['brief_linkage_minimum']),
    evidenceIntegrityMinimum: number(raw['evidence_integrity_minimum']),
    expectedBehaviorMinimum: number(raw['expected_behavior_minimum']),
    noEvidenceSafetyMinimum: number(raw['no_evidence_safety_minimum']),
    schemaValidityMinimum: number(raw['schema_validity_minimum']),
    scopeComplianceMinimum: number(raw['scope_compliance_minimum']),
  };
  if (Object.values(thresholds).some((item) => !Number.isFinite(item) || item < 0 || item > 1)) {
    invalid();
  }
  return Object.freeze({
    caseIds: Object.freeze([...ids] as string[]),
    datasetVersion: value['dataset_version'],
    schemaVersion: 'topic-planner-eval-manifest@1',
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
  throw new TypeError('Topic Planner evaluation manifest is invalid');
}
