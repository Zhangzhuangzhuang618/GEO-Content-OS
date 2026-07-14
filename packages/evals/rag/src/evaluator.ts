import {
  RAG_EVAL_REPORT_SCHEMA,
  type RagCasePrediction,
  type RagEvalCase,
  type RagEvalDataset,
  type RagEvalGateResult,
  type RagEvalMetrics,
  type RagEvalPredictions,
  type RagEvalReport,
} from './types.js';

export interface EvaluateRagOptions {
  readonly datasetSha256: string;
  readonly evaluatedAt?: string;
}

export function evaluateRag(
  dataset: RagEvalDataset,
  predictions: RagEvalPredictions,
  options: EvaluateRagOptions,
): RagEvalReport {
  if (predictions.datasetVersion !== dataset.datasetVersion) {
    throw new TypeError('Prediction dataset version does not match the evaluation dataset');
  }
  const predictionsByCase = new Map(
    predictions.predictions.map((prediction) => [prediction.caseId, prediction]),
  );
  if (
    predictionsByCase.size !== dataset.cases.length ||
    dataset.cases.some((item) => !predictionsByCase.has(item.caseId)) ||
    predictions.predictions.some(
      (prediction) => !dataset.cases.some((item) => item.caseId === prediction.caseId),
    )
  ) {
    throw new TypeError('Predictions must contain exactly one result for every evaluation case');
  }

  let accurateCitations = 0;
  let fabricatedCitations = 0;
  let relevantCitations = 0;
  let returnedCitations = 0;
  let totalRelevant = 0;
  let highRiskRelevant = 0;
  let highRiskReturned = 0;
  let highRiskCases = 0;
  let noAnswerCases = 0;
  let correctNoAnswers = 0;
  const latencies: number[] = [];

  for (const item of dataset.cases) {
    const prediction = predictionsByCase.get(item.caseId)!;
    const result = scoreCase(item, prediction, dataset.topK);
    accurateCitations += result.accurate;
    fabricatedCitations += result.fabricated;
    relevantCitations += result.relevant;
    returnedCitations += result.returned;
    totalRelevant += item.expectedEvidence.length;
    latencies.push(prediction.latencyMs);
    if (item.expectedEvidence.length === 0) {
      noAnswerCases += 1;
      if (result.returned === 0) correctNoAnswers += 1;
    }
    if (item.riskLevel === 'critical' || item.riskLevel === 'high') {
      highRiskCases += 1;
      highRiskRelevant += result.relevant;
      highRiskReturned += result.returned;
    }
  }

  const metrics: RagEvalMetrics = Object.freeze({
    caseCount: dataset.cases.length,
    citationAccuracy: divide(accurateCitations, returnedCitations),
    fabricatedCitationCount: fabricatedCitations,
    fabricatedCitationRate: divide(fabricatedCitations, returnedCitations),
    highRiskCaseCount: highRiskCases,
    highRiskPrecision: divide(highRiskRelevant, highRiskReturned),
    latencyMaximumMs: stable(Math.max(...latencies)),
    latencyMeanMs: stable(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    noAnswerAccuracy: noAnswerCases === 0 ? 1 : divide(correctNoAnswers, noAnswerCases),
    noAnswerCaseCount: noAnswerCases,
    precision: divide(relevantCitations, returnedCitations),
    recall: divide(relevantCitations, totalRelevant),
    returnedCitationCount: returnedCitations,
  });
  const gates = Object.freeze(gateResults(metrics, dataset.thresholds));
  return Object.freeze({
    datasetSha256: options.datasetSha256,
    datasetVersion: dataset.datasetVersion,
    evaluatedAt: normalizeTimestamp(options.evaluatedAt),
    gates,
    metrics,
    passed: gates.every((gate) => gate.passed),
    schemaVersion: RAG_EVAL_REPORT_SCHEMA,
    systemVersion: predictions.systemVersion,
    topK: dataset.topK,
  });
}

function scoreCase(item: RagEvalCase, prediction: RagCasePrediction, topK: number) {
  const expectedById = new Map(item.expectedEvidence.map((entry) => [entry.chunkId, entry]));
  const chunksById = new Map(item.chunks.map((entry) => [entry.chunkId, entry]));
  let accurate = 0;
  let fabricated = 0;
  let relevant = 0;
  const citations = prediction.citations.slice(0, topK);
  for (const citation of citations) {
    const chunk = chunksById.get(citation.chunkId);
    const integrityValid =
      chunk !== undefined &&
      chunk.textHash === citation.textHash &&
      chunk.text.includes(citation.quote);
    if (!integrityValid) fabricated += 1;
    const expected = expectedById.get(citation.chunkId);
    if (integrityValid && expected) {
      relevant += 1;
      if (citation.quote.includes(expected.requiredQuote)) accurate += 1;
    }
  }
  return { accurate, fabricated, relevant, returned: citations.length };
}

function gateResults(
  metrics: RagEvalMetrics,
  thresholds: RagEvalDataset['thresholds'],
): RagEvalGateResult[] {
  return [
    minimumGate(
      'citationAccuracyMinimum',
      metrics.citationAccuracy,
      thresholds.citationAccuracyMinimum,
    ),
    maximumGate(
      'fabricatedCitationMaximum',
      metrics.fabricatedCitationCount,
      thresholds.fabricatedCitationMaximum,
    ),
    minimumGate(
      'highRiskPrecisionMinimum',
      metrics.highRiskPrecision,
      thresholds.highRiskPrecisionMinimum,
    ),
    maximumGate('latencyP95MaximumMs', metrics.latencyP95Ms, thresholds.latencyP95MaximumMs),
    minimumGate(
      'noAnswerAccuracyMinimum',
      metrics.noAnswerAccuracy,
      thresholds.noAnswerAccuracyMinimum,
    ),
    minimumGate('precisionMinimum', metrics.precision, thresholds.precisionMinimum),
    minimumGate('recallMinimum', metrics.recall, thresholds.recallMinimum),
  ];
}

function minimumGate(
  gate: keyof RagEvalDataset['thresholds'],
  actual: number,
  threshold: number,
): RagEvalGateResult {
  return Object.freeze({ actual, gate, passed: actual >= threshold, threshold });
}

function maximumGate(
  gate: keyof RagEvalDataset['thresholds'],
  actual: number,
  threshold: number,
): RagEvalGateResult {
  return Object.freeze({ actual, gate, passed: actual <= threshold, threshold });
}

function percentile(values: readonly number[], ratio: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const rank = Math.max(0, Math.ceil(ratio * ordered.length) - 1);
  return stable(ordered[rank] ?? 0);
}

function divide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : stable(numerator / denominator);
}

function stable(value: number): number {
  return Number(value.toFixed(12));
}

function normalizeTimestamp(value?: string): string {
  if (value === undefined) return new Date().toISOString();
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new TypeError('Evaluation timestamp must be a canonical ISO timestamp');
  }
  return value;
}
