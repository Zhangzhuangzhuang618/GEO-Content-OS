import { readFile } from 'node:fs/promises';

import type { MaterialParserEvalManifest, MaterialParserEvalThresholds } from './types.js';

const THRESHOLD_KEYS = [
  'candidate_fact_grounding_minimum',
  'expected_behavior_minimum',
  'locator_accuracy_minimum',
  'prompt_injection_execution_maximum',
  'provenance_accuracy_minimum',
  'schema_validity_minimum',
] as const;

export async function loadManifest(path: string): Promise<MaterialParserEvalManifest> {
  return parseManifest(JSON.parse(await readFile(path, 'utf8')));
}

export function parseManifest(value: unknown): MaterialParserEvalManifest {
  if (!record(value) || value['schema_version'] !== 'material-parser-eval-manifest@1') invalid();
  const caseIds = value['case_ids'];
  const thresholds = value['thresholds'];
  if (
    typeof value['dataset_version'] !== 'string' ||
    !Array.isArray(caseIds) ||
    caseIds.length < 3 ||
    caseIds.some((item) => typeof item !== 'string' || !item) ||
    new Set(caseIds).size !== caseIds.length ||
    !record(thresholds) ||
    Object.keys(thresholds).length !== THRESHOLD_KEYS.length ||
    THRESHOLD_KEYS.some((key) => typeof thresholds[key] !== 'number')
  ) {
    invalid();
  }
  const mapped: MaterialParserEvalThresholds = {
    candidateFactGroundingMinimum: number(thresholds['candidate_fact_grounding_minimum']),
    expectedBehaviorMinimum: number(thresholds['expected_behavior_minimum']),
    locatorAccuracyMinimum: number(thresholds['locator_accuracy_minimum']),
    promptInjectionExecutionMaximum: number(thresholds['prompt_injection_execution_maximum']),
    provenanceAccuracyMinimum: number(thresholds['provenance_accuracy_minimum']),
    schemaValidityMinimum: number(thresholds['schema_validity_minimum']),
  };
  for (const threshold of Object.values(mapped)) {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) invalid();
  }
  return Object.freeze({
    caseIds: Object.freeze([...caseIds] as string[]),
    datasetVersion: value['dataset_version'],
    schemaVersion: 'material-parser-eval-manifest@1',
    thresholds: Object.freeze(mapped),
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
  throw new TypeError('Material Parser evaluation manifest is invalid');
}
