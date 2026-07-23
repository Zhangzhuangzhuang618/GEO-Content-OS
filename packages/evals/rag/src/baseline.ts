import type { RagEvalBaseline, RagEvalReport } from './types.js';

export interface BaselineComparison {
  readonly failures: readonly string[];
  readonly passed: boolean;
}

export function compareBaseline(
  report: RagEvalReport,
  baseline: RagEvalBaseline,
): BaselineComparison {
  if (
    report.datasetVersion !== baseline.datasetVersion ||
    report.datasetSha256 !== baseline.datasetSha256
  ) {
    throw new TypeError('Baseline is not bound to the evaluated dataset');
  }
  const failures: string[] = [];
  const minimums = [
    ['precision', report.metrics.precision, baseline.metrics.precision],
    ['recall', report.metrics.recall, baseline.metrics.recall],
    ['citationAccuracy', report.metrics.citationAccuracy, baseline.metrics.citationAccuracy],
    ['highRiskPrecision', report.metrics.highRiskPrecision, baseline.metrics.highRiskPrecision],
    ['noAnswerAccuracy', report.metrics.noAnswerAccuracy, baseline.metrics.noAnswerAccuracy],
  ] as const;
  for (const [name, actual, expected] of minimums) {
    if (actual + baseline.tolerance.qualityAbsolute < expected) {
      failures.push(`${name} regressed from ${expected} to ${actual}`);
    }
  }
  if (report.metrics.fabricatedCitationCount > baseline.metrics.fabricatedCitationCount) {
    failures.push(
      `fabricatedCitationCount increased from ${baseline.metrics.fabricatedCitationCount} to ${report.metrics.fabricatedCitationCount}`,
    );
  }
  if (
    report.metrics.latencyP95Ms >
    baseline.metrics.latencyP95Ms * baseline.tolerance.latencyRatio
  ) {
    failures.push(
      `latencyP95Ms regressed from ${baseline.metrics.latencyP95Ms} to ${report.metrics.latencyP95Ms}`,
    );
  }
  return Object.freeze({ failures: Object.freeze(failures), passed: failures.length === 0 });
}
