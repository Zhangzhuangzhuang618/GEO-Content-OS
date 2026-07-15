import { readFile } from 'node:fs/promises';

import type { ContentWriterEvalManifest, ContentWriterEvalThresholds } from './types.js';

const THRESHOLD_KEYS = [
  'citation_grounding_minimum',
  'expected_behavior_minimum',
  'locked_block_preservation_minimum',
  'platform_coverage_minimum',
  'prompt_injection_execution_maximum',
  'provenance_accuracy_minimum',
  'schema_validity_minimum',
] as const;

export async function loadManifest(path: string): Promise<ContentWriterEvalManifest> {
  return parseManifest(JSON.parse(await readFile(path, 'utf8')));
}

export function parseManifest(value: unknown): ContentWriterEvalManifest {
  if (!record(value) || value['schema_version'] !== 'content-writer-eval-manifest@1') invalid();
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
  const mapped: ContentWriterEvalThresholds = {
    citationGroundingMinimum: number(thresholds['citation_grounding_minimum']),
    expectedBehaviorMinimum: number(thresholds['expected_behavior_minimum']),
    lockedBlockPreservationMinimum: number(thresholds['locked_block_preservation_minimum']),
    platformCoverageMinimum: number(thresholds['platform_coverage_minimum']),
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
    schemaVersion: 'content-writer-eval-manifest@1',
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
  throw new TypeError('Content Writer evaluation manifest is invalid');
}
