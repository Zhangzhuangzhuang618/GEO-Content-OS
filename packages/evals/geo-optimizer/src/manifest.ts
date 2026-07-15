import { readFile } from 'node:fs/promises';

import type { GeoOptimizerEvalManifest, GeoOptimizerEvalThresholds } from './types.js';

const KEYS = [
  'citation_integrity_minimum',
  'expected_behavior_minimum',
  'lock_integrity_minimum',
  'rewrite_plan_integrity_minimum',
  'schema_validity_minimum',
  'weighted_score_minimum',
] as const;

export async function loadManifest(path: string): Promise<GeoOptimizerEvalManifest> {
  return parseManifest(JSON.parse(await readFile(path, 'utf8')));
}

export function parseManifest(value: unknown): GeoOptimizerEvalManifest {
  if (!record(value) || value['schema_version'] !== 'geo-optimizer-eval-manifest@1') invalid();
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
  ) {
    invalid();
  }
  const thresholds: GeoOptimizerEvalThresholds = {
    citationIntegrityMinimum: number(raw['citation_integrity_minimum']),
    expectedBehaviorMinimum: number(raw['expected_behavior_minimum']),
    lockIntegrityMinimum: number(raw['lock_integrity_minimum']),
    rewritePlanIntegrityMinimum: number(raw['rewrite_plan_integrity_minimum']),
    schemaValidityMinimum: number(raw['schema_validity_minimum']),
    weightedScoreMinimum: number(raw['weighted_score_minimum']),
  };
  if (Object.values(thresholds).some((item) => !Number.isFinite(item) || item < 0 || item > 1)) {
    invalid();
  }
  return Object.freeze({
    caseIds: Object.freeze([...ids] as string[]),
    datasetVersion: value['dataset_version'],
    schemaVersion: 'geo-optimizer-eval-manifest@1',
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
  throw new TypeError('Geo Optimizer evaluation manifest is invalid');
}
