import { GEO_OPTIMIZER_OUTPUT_SCHEMA } from '@geo-content-os/contracts/skills';
import {
  GEO_OPTIMIZER_CONTRACT_V1,
  type GeoOptimizerFewShot,
} from '@geo-content-os/skills/geo-optimizer';
import { SchemaGuard } from '@geo-content-os/skills/runtime';

import type {
  GeoOptimizerEvalGate,
  GeoOptimizerEvalManifest,
  GeoOptimizerEvalMetrics,
  GeoOptimizerEvalReport,
  GeoOptimizerEvalThresholds,
} from './types.js';

interface EvalInput {
  readonly citations: readonly {
    readonly chunk_id: string;
    readonly citation_id: string;
    readonly quote_text: string;
    readonly source_id: string;
  }[];
  readonly content_version: {
    readonly content: {
      readonly blocks: readonly { readonly block_key: string }[];
      readonly citation_map: readonly {
        readonly citation_ids: readonly string[];
        readonly claim_key: string;
        readonly claim_text: string;
      }[];
    };
  };
  readonly locked_blocks: readonly { readonly block_key: string; readonly text: string }[];
}

export function evaluateGeoOptimizer(
  manifest: GeoOptimizerEvalManifest,
  cases: readonly GeoOptimizerFewShot[] = GEO_OPTIMIZER_CONTRACT_V1.fewShots,
  evaluatedAt?: string,
): GeoOptimizerEvalReport {
  assertCases(manifest, cases);
  const guard = new SchemaGuard();
  const counts = { citations: 0, expected: 0, locks: 0, plans: 0, schemas: 0, scores: 0 };
  for (const item of cases) {
    if (guard.check(GEO_OPTIMIZER_OUTPUT_SCHEMA, item.output).valid) counts.schemas += 1;
    if (citationIntegrity(item)) counts.citations += 1;
    if (lockIntegrity(item)) counts.locks += 1;
    if (rewritePlanIntegrity(item)) counts.plans += 1;
    if (weightedScore(item)) counts.scores += 1;
    if (expectedBehavior(item)) counts.expected += 1;
  }
  const metrics: GeoOptimizerEvalMetrics = Object.freeze({
    caseCount: cases.length,
    citationIntegrity: ratio(counts.citations, cases.length),
    expectedBehavior: ratio(counts.expected, cases.length),
    lockIntegrity: ratio(counts.locks, cases.length),
    rewritePlanIntegrity: ratio(counts.plans, cases.length),
    schemaValidity: ratio(counts.schemas, cases.length),
    weightedScore: ratio(counts.scores, cases.length),
  });
  const gates = Object.freeze(buildGates(metrics, manifest.thresholds));
  return Object.freeze({
    datasetVersion: manifest.datasetVersion,
    evaluatedAt: timestamp(evaluatedAt),
    gates,
    metrics,
    passed: gates.every((gate) => gate.passed),
    schemaVersion: 'geo-optimizer-eval-report@1',
    skillVersion: '1.0.0',
  });
}

function assertCases(
  manifest: GeoOptimizerEvalManifest,
  cases: readonly GeoOptimizerFewShot[],
): void {
  if (
    cases.length !== manifest.caseIds.length ||
    cases.some((item, index) => item.id !== manifest.caseIds[index])
  ) {
    throw new TypeError('Evaluation cases do not match the versioned manifest');
  }
}

function citationIntegrity(item: GeoOptimizerFewShot): boolean {
  const input = item.input as unknown as EvalInput;
  const optimized = item.output.data.optimized_content.citation_map;
  const requiredIds = new Set(
    input.content_version.content.citation_map.flatMap((mapping) => mapping.citation_ids),
  );
  return (
    input.content_version.content.citation_map.every((original) => {
      const mapping = optimized.find(
        (candidate) =>
          candidate.claim_key === original.claim_key &&
          candidate.claim_text === original.claim_text,
      );
      return (
        mapping !== undefined &&
        original.citation_ids.every((citationId) => mapping.citation_ids.includes(citationId))
      );
    }) &&
    [...requiredIds].every((citationId) => {
      const source = input.citations.find((citation) => citation.citation_id === citationId);
      return (
        source !== undefined &&
        item.output.citations.some(
          (citation) =>
            source.chunk_id === citation.chunk_id &&
            source.source_id === citation.source_id &&
            source.quote_text.includes(citation.quote_text),
        )
      );
    }) &&
    item.output.citations.every((citation) =>
      input.citations.some(
        (source) =>
          source.chunk_id === citation.chunk_id &&
          source.source_id === citation.source_id &&
          source.quote_text.includes(citation.quote_text),
      ),
    )
  );
}

function lockIntegrity(item: GeoOptimizerFewShot): boolean {
  const input = item.input as unknown as EvalInput;
  return input.locked_blocks.every((locked) => {
    const block = item.output.data.optimized_content.blocks.find(
      (candidate) => candidate.block_key === locked.block_key,
    );
    return (
      block?.text === locked.text &&
      item.output.data.rewrite_plan
        .filter((plan) => plan.block_key === locked.block_key)
        .every((plan) => plan.operation === 'keep')
    );
  });
}

function rewritePlanIntegrity(item: GeoOptimizerFewShot): boolean {
  const input = item.input as unknown as EvalInput;
  const originalKeys = new Set(
    input.content_version.content.blocks.map((block) => block.block_key),
  );
  const optimizedKeys = new Set(
    item.output.data.optimized_content.blocks.map((block) => block.block_key),
  );
  return item.output.data.rewrite_plan.every(
    (plan) =>
      optimizedKeys.has(plan.block_key) &&
      (plan.operation === 'add'
        ? !originalKeys.has(plan.block_key)
        : originalKeys.has(plan.block_key)),
  );
}

function weightedScore(item: GeoOptimizerFewShot): boolean {
  const score = item.output.data.scores;
  const expected =
    score.entity * 0.2 +
    score.question * 0.2 +
    score.answerability * 0.2 +
    score.evidence * 0.2 +
    score.platform_fit * 0.1 +
    score.readability_safety * 0.1;
  return Math.abs(score.total - expected) <= 0.000_001;
}

function expectedBehavior(item: GeoOptimizerFewShot): boolean {
  if (item.id === 'answerability-positive') {
    return (
      item.output.status === 'success' &&
      item.output.data.rewrite_plan.some((plan) => plan.operation === 'rewrite')
    );
  }
  if (item.id === 'citation-loss-negative') {
    return (
      item.output.status === 'failed' &&
      item.output.blockers.some((blocker) => blocker.code === 'CITATION_LOSS') &&
      item.output.warnings.some((warning) => warning.code === 'PROMPT_INJECTION_IGNORED')
    );
  }
  if (item.id === 'locked-block-boundary') {
    return lockIntegrity(item) && item.output.status === 'success';
  }
  return false;
}

function buildGates(
  metrics: GeoOptimizerEvalMetrics,
  thresholds: GeoOptimizerEvalThresholds,
): GeoOptimizerEvalGate[] {
  return [
    gate('citationIntegrityMinimum', metrics.citationIntegrity, thresholds),
    gate('expectedBehaviorMinimum', metrics.expectedBehavior, thresholds),
    gate('lockIntegrityMinimum', metrics.lockIntegrity, thresholds),
    gate('rewritePlanIntegrityMinimum', metrics.rewritePlanIntegrity, thresholds),
    gate('schemaValidityMinimum', metrics.schemaValidity, thresholds),
    gate('weightedScoreMinimum', metrics.weightedScore, thresholds),
  ];
}

function gate(
  name: keyof GeoOptimizerEvalThresholds,
  actual: number,
  thresholds: GeoOptimizerEvalThresholds,
): GeoOptimizerEvalGate {
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
