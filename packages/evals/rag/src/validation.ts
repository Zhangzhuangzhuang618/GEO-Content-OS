import { createHash } from 'node:crypto';

import {
  RAG_EVAL_BASELINE_SCHEMA,
  RAG_EVAL_DATASET_SCHEMA,
  RAG_EVAL_PREDICTIONS_SCHEMA,
  type RagEvalBaseline,
  type RagEvalDataset,
  type RagEvalPredictions,
} from './types.js';

const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const MAX_CASES = 10_000;

export function parseDataset(raw: unknown): RagEvalDataset {
  const value = record(raw, 'RAG evaluation dataset');
  exactKeys(value, ['cases', 'dataset_version', 'schema_version', 'thresholds', 'top_k']);
  if (value.schema_version !== RAG_EVAL_DATASET_SCHEMA) invalid('dataset schema version');
  const datasetVersion = safeId(value.dataset_version, 'dataset version');
  const topK = integer(value.top_k, 1, 100, 'top_k');
  const thresholds = parseThresholds(value.thresholds);
  if (!Array.isArray(value.cases) || value.cases.length < 300 || value.cases.length > MAX_CASES) {
    invalid('dataset must contain 300 to 10000 cases');
  }
  const caseIds = new Set<string>();
  const cases = value.cases.map((item, index) => {
    const candidate = record(item, `case ${index}`);
    exactKeys(candidate, ['case_id', 'chunks', 'expected_evidence', 'query', 'risk_level']);
    const caseId = safeId(candidate.case_id, `case ${index} id`);
    if (caseIds.has(caseId)) invalid('case IDs must be unique');
    caseIds.add(caseId);
    const query = boundedText(candidate.query, 2, 500, `case ${caseId} query`);
    if (
      candidate.risk_level !== 'critical' &&
      candidate.risk_level !== 'high' &&
      candidate.risk_level !== 'normal'
    ) {
      invalid(`case ${caseId} risk level`);
    }
    if (
      !Array.isArray(candidate.chunks) ||
      candidate.chunks.length < 1 ||
      candidate.chunks.length > 100
    ) {
      invalid(`case ${caseId} chunks`);
    }
    const chunkIds = new Set<string>();
    const chunks = candidate.chunks.map((item, chunkIndex) => {
      const chunk = record(item, `case ${caseId} chunk ${chunkIndex}`);
      exactKeys(chunk, ['chunk_id', 'text', 'text_hash']);
      const chunkId = safeId(chunk.chunk_id, `case ${caseId} chunk ID`);
      if (chunkIds.has(chunkId)) invalid(`case ${caseId} chunk IDs must be unique`);
      chunkIds.add(chunkId);
      const text = boundedText(chunk.text, 1, 20_000, `case ${caseId} chunk text`);
      const textHash = hash(chunk.text_hash, `case ${caseId} chunk hash`);
      if (sha256(text) !== textHash) invalid(`case ${caseId} chunk hash mismatch`);
      return Object.freeze({ chunkId, text, textHash });
    });
    if (
      !Array.isArray(candidate.expected_evidence) ||
      candidate.expected_evidence.length > Math.min(topK, chunks.length)
    ) {
      invalid(`case ${caseId} expected evidence`);
    }
    const evidenceIds = new Set<string>();
    const expectedEvidence = candidate.expected_evidence.map((item, evidenceIndex) => {
      const evidence = record(item, `case ${caseId} evidence ${evidenceIndex}`);
      exactKeys(evidence, ['chunk_id', 'required_quote']);
      const chunkId = safeId(evidence.chunk_id, `case ${caseId} evidence chunk ID`);
      const chunk = chunks.find((entry) => entry.chunkId === chunkId);
      const requiredQuote = boundedText(
        evidence.required_quote,
        1,
        2_000,
        `case ${caseId} required quote`,
      );
      if (!chunk || evidenceIds.has(chunkId) || !chunk.text.includes(requiredQuote)) {
        invalid(`case ${caseId} evidence provenance`);
      }
      evidenceIds.add(chunkId);
      return Object.freeze({ chunkId, requiredQuote });
    });
    return Object.freeze({
      caseId,
      chunks: Object.freeze(chunks),
      expectedEvidence: Object.freeze(expectedEvidence),
      query,
      riskLevel: candidate.risk_level,
    });
  });
  const highRiskCases = cases.filter(
    (item) => item.riskLevel === 'critical' || item.riskLevel === 'high',
  ).length;
  if (highRiskCases < 300) invalid('dataset must contain at least 300 high-risk cases');
  return Object.freeze({
    cases: Object.freeze(cases),
    datasetVersion,
    schemaVersion: RAG_EVAL_DATASET_SCHEMA,
    thresholds,
    topK,
  });
}

export function parsePredictions(raw: unknown): RagEvalPredictions {
  const value = record(raw, 'RAG predictions');
  exactKeys(value, ['dataset_version', 'predictions', 'schema_version', 'system_version']);
  if (value.schema_version !== RAG_EVAL_PREDICTIONS_SCHEMA) invalid('predictions schema version');
  if (
    !Array.isArray(value.predictions) ||
    value.predictions.length < 1 ||
    value.predictions.length > MAX_CASES
  ) {
    invalid('predictions count');
  }
  const caseIds = new Set<string>();
  const predictions = value.predictions.map((item, index) => {
    const prediction = record(item, `prediction ${index}`);
    exactKeys(prediction, ['case_id', 'citations', 'latency_ms']);
    const caseId = safeId(prediction.case_id, `prediction ${index} case ID`);
    if (caseIds.has(caseId)) invalid('prediction case IDs must be unique');
    caseIds.add(caseId);
    if (!Array.isArray(prediction.citations) || prediction.citations.length > 100) {
      invalid(`prediction ${caseId} citations`);
    }
    const chunkIds = new Set<string>();
    const citations = prediction.citations.map((item, citationIndex) => {
      const citation = record(item, `prediction ${caseId} citation ${citationIndex}`);
      exactKeys(citation, ['chunk_id', 'quote', 'text_hash']);
      const chunkId = safeId(citation.chunk_id, `prediction ${caseId} citation chunk ID`);
      if (chunkIds.has(chunkId)) invalid(`prediction ${caseId} citation IDs must be unique`);
      chunkIds.add(chunkId);
      return Object.freeze({
        chunkId,
        quote: boundedText(citation.quote, 1, 2_000, `prediction ${caseId} quote`),
        textHash: hash(citation.text_hash, `prediction ${caseId} citation hash`),
      });
    });
    return Object.freeze({
      caseId,
      citations: Object.freeze(citations),
      latencyMs: finiteNumber(prediction.latency_ms, 0, 3_600_000, `prediction ${caseId} latency`),
    });
  });
  return Object.freeze({
    datasetVersion: safeId(value.dataset_version, 'predictions dataset version'),
    predictions: Object.freeze(predictions),
    schemaVersion: RAG_EVAL_PREDICTIONS_SCHEMA,
    systemVersion: safeId(value.system_version, 'predictions system version'),
  });
}

export function parseBaseline(raw: unknown): RagEvalBaseline {
  const value = record(raw, 'RAG baseline');
  exactKeys(value, [
    'dataset_sha256',
    'dataset_version',
    'metrics',
    'schema_version',
    'system_version',
    'tolerance',
  ]);
  if (value.schema_version !== RAG_EVAL_BASELINE_SCHEMA) invalid('baseline schema version');
  const metrics = record(value.metrics, 'baseline metrics');
  exactKeys(metrics, [
    'citation_accuracy',
    'fabricated_citation_count',
    'high_risk_precision',
    'latency_p95_ms',
    'no_answer_accuracy',
    'precision',
    'recall',
  ]);
  const tolerance = record(value.tolerance, 'baseline tolerance');
  exactKeys(tolerance, ['latency_ratio', 'quality_absolute']);
  return Object.freeze({
    datasetSha256: hash(value.dataset_sha256, 'baseline dataset hash'),
    datasetVersion: safeId(value.dataset_version, 'baseline dataset version'),
    metrics: Object.freeze({
      citationAccuracy: ratio(metrics.citation_accuracy, 'baseline citation accuracy'),
      fabricatedCitationCount: integer(
        metrics.fabricated_citation_count,
        0,
        1_000_000,
        'baseline fabricated count',
      ),
      highRiskPrecision: ratio(metrics.high_risk_precision, 'baseline high risk precision'),
      latencyP95Ms: finiteNumber(metrics.latency_p95_ms, 0, 3_600_000, 'baseline p95'),
      noAnswerAccuracy: ratio(metrics.no_answer_accuracy, 'baseline no-answer accuracy'),
      precision: ratio(metrics.precision, 'baseline precision'),
      recall: ratio(metrics.recall, 'baseline recall'),
    }),
    schemaVersion: RAG_EVAL_BASELINE_SCHEMA,
    systemVersion: safeId(value.system_version, 'baseline system version'),
    tolerance: Object.freeze({
      latencyRatio: finiteNumber(tolerance.latency_ratio, 1, 10, 'baseline latency tolerance'),
      qualityAbsolute: finiteNumber(
        tolerance.quality_absolute,
        0,
        0.25,
        'baseline quality tolerance',
      ),
    }),
  });
}

function parseThresholds(raw: unknown) {
  const value = record(raw, 'dataset thresholds');
  exactKeys(value, [
    'citation_accuracy_minimum',
    'fabricated_citation_maximum',
    'high_risk_precision_minimum',
    'latency_p95_maximum_ms',
    'no_answer_accuracy_minimum',
    'precision_minimum',
    'recall_minimum',
  ]);
  return Object.freeze({
    citationAccuracyMinimum: ratio(value.citation_accuracy_minimum, 'citation accuracy threshold'),
    fabricatedCitationMaximum: integer(
      value.fabricated_citation_maximum,
      0,
      1_000_000,
      'fabricated citation threshold',
    ),
    highRiskPrecisionMinimum: ratio(
      value.high_risk_precision_minimum,
      'high risk precision threshold',
    ),
    latencyP95MaximumMs: finiteNumber(
      value.latency_p95_maximum_ms,
      1,
      3_600_000,
      'latency threshold',
    ),
    noAnswerAccuracyMinimum: ratio(
      value.no_answer_accuracy_minimum,
      'no-answer accuracy threshold',
    ),
    precisionMinimum: ratio(value.precision_minimum, 'precision threshold'),
    recallMinimum: ratio(value.recall_minimum, 'recall threshold'),
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(label);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(`unexpected fields: ${actual.join(',')}`);
  }
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) invalid(label);
  return value;
}

function boundedText(value: unknown, minimum: number, maximum: number, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    !value.trim()
  ) {
    invalid(label);
  }
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) invalid(label);
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(label);
  }
  return value as number;
}

function finiteNumber(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(label);
  }
  return value;
}

function ratio(value: unknown, label: string): number {
  return finiteNumber(value, 0, 1, label);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function invalid(label: string): never {
  throw new TypeError(`Invalid ${label}`);
}
