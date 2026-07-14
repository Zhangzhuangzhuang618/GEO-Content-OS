import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { compareBaseline } from './baseline.js';
import { evaluateRag } from './evaluator.js';
import { RAG_EVAL_BASELINE_SCHEMA, type RagEvalBaseline } from './types.js';
import { parseDataset, parsePredictions } from './validation.js';

const DATASET_HASH = 'd'.repeat(64);
const EVALUATED_AT = '2026-07-14T00:00:00.000Z';

describe('offline RAG evaluator', () => {
  it('reports quality, citation integrity, high-risk precision and latency percentiles', () => {
    const dataset = parseDataset(rawDataset());
    const predictions = parsePredictions(rawPredictions());
    const report = evaluateRag(dataset, predictions, {
      datasetSha256: DATASET_HASH,
      evaluatedAt: EVALUATED_AT,
    });

    expect(report).toMatchObject({
      datasetSha256: DATASET_HASH,
      datasetVersion: 'rag-eval-v1',
      evaluatedAt: EVALUATED_AT,
      passed: true,
      metrics: {
        caseCount: 300,
        citationAccuracy: 1,
        fabricatedCitationCount: 0,
        highRiskCaseCount: 300,
        highRiskPrecision: 1,
        latencyMaximumMs: 59,
        latencyP50Ms: 38,
        latencyP95Ms: 57,
        noAnswerAccuracy: 1,
        noAnswerCaseCount: 30,
        precision: 1,
        recall: 1,
        returnedCitationCount: 540,
      },
    });
    expect(report.gates).toHaveLength(7);
    expect(report.gates.every((gate) => gate.passed)).toBe(true);
  });

  it('counts a forged hash or quote and fails the zero-fabrication gate', () => {
    const dataset = parseDataset(rawDataset());
    const raw = rawPredictions();
    raw.predictions[0]!.citations[0] = {
      ...raw.predictions[0]!.citations[0]!,
      quote: '不存在的伪造引文',
      text_hash: 'f'.repeat(64),
    };
    const report = evaluateRag(dataset, parsePredictions(raw), {
      datasetSha256: DATASET_HASH,
      evaluatedAt: EVALUATED_AT,
    });
    expect(report.metrics).toMatchObject({
      fabricatedCitationCount: 1,
      fabricatedCitationRate: 0.001851851852,
    });
    expect(report.passed).toBe(false);
  });

  it('penalizes a grounded but unsupported citation on a no-answer case', () => {
    const dataset = rawDataset();
    const raw = rawPredictions();
    const noAnswerCase = dataset.cases[9]!;
    const noise = noAnswerCase.chunks[2]!;
    raw.predictions[9]!.citations = [
      { chunk_id: noise.chunk_id, quote: noise.text, text_hash: noise.text_hash },
    ];
    const report = evaluateRag(parseDataset(dataset), parsePredictions(raw), {
      datasetSha256: DATASET_HASH,
      evaluatedAt: EVALUATED_AT,
    });
    expect(report.metrics).toMatchObject({
      fabricatedCitationCount: 0,
      noAnswerAccuracy: 0.966666666667,
    });
    expect(report.passed).toBe(true);

    for (let index = 9; index < 60; index += 10) {
      const item = dataset.cases[index]!;
      const chunk_ = item.chunks[2]!;
      raw.predictions[index]!.citations = [
        { chunk_id: chunk_.chunk_id, quote: chunk_.text, text_hash: chunk_.text_hash },
      ];
    }
    expect(
      evaluateRag(parseDataset(dataset), parsePredictions(raw), {
        datasetSha256: DATASET_HASH,
        evaluatedAt: EVALUATED_AT,
      }).passed,
    ).toBe(false);
  });

  it('does not inflate recall with missing, duplicate or unknown cases', () => {
    const raw = rawPredictions();
    raw.predictions.pop();
    expect(() =>
      evaluateRag(parseDataset(rawDataset()), parsePredictions(raw), {
        datasetSha256: DATASET_HASH,
      }),
    ).toThrow(/exactly one result/u);

    const duplicate = rawPredictions();
    duplicate.predictions[1] = duplicate.predictions[0]!;
    expect(() => parsePredictions(duplicate)).toThrow(/case IDs must be unique/u);
  });

  it('rejects poisoned dataset provenance and insufficient high-risk coverage', () => {
    const poisoned = rawDataset();
    poisoned.cases[0]!.chunks[0]!.text_hash = '0'.repeat(64);
    expect(() => parseDataset(poisoned)).toThrow(/hash mismatch/u);

    const insufficient = rawDataset();
    (insufficient.cases[0]! as { risk_level: string }).risk_level = 'normal';
    expect(() => parseDataset(insufficient)).toThrow(/at least 300 high-risk/u);
  });

  it('detects quality and latency regressions against the dataset-bound baseline', () => {
    const report = evaluateRag(parseDataset(rawDataset()), parsePredictions(rawPredictions()), {
      datasetSha256: DATASET_HASH,
      evaluatedAt: EVALUATED_AT,
    });
    expect(compareBaseline(report, baseline())).toEqual({ failures: [], passed: true });
    const strict = {
      ...baseline(),
      metrics: { ...baseline().metrics, latencyP95Ms: 20, recall: 1.1 },
    } as RagEvalBaseline;
    expect(compareBaseline(report, strict)).toMatchObject({ passed: false });
  });

  it('rejects a baseline from another immutable dataset', () => {
    const report = evaluateRag(parseDataset(rawDataset()), parsePredictions(rawPredictions()), {
      datasetSha256: DATASET_HASH,
      evaluatedAt: EVALUATED_AT,
    });
    expect(() => compareBaseline(report, { ...baseline(), datasetSha256: 'e'.repeat(64) })).toThrow(
      /not bound/u,
    );
  });
});

function rawDataset() {
  return {
    cases: Array.from({ length: 300 }, (_, index) => {
      const ordinal = String(index + 1).padStart(3, '0');
      const firstText = `产品${ordinal}的官方发布日期为2026年${(index % 12) + 1}月1日。`;
      const secondText = `产品${ordinal}的官方保修期为${(index % 3) + 1}年。`;
      return {
        case_id: `rag-${ordinal}`,
        chunks: [
          chunk(`chunk-${ordinal}-date`, firstText),
          chunk(`chunk-${ordinal}-warranty`, secondText),
          chunk(`chunk-${ordinal}-noise`, `产品${ordinal}的宣传资料不包含日期或保修承诺。`),
        ],
        expected_evidence:
          index % 10 === 9
            ? []
            : [
                { chunk_id: `chunk-${ordinal}-date`, required_quote: '官方发布日期' },
                { chunk_id: `chunk-${ordinal}-warranty`, required_quote: '官方保修期' },
              ],
        query:
          index % 10 === 9
            ? `产品${ordinal}的市场占有率排名是多少？`
            : `产品${ordinal}何时发布，保修期多久？`,
        risk_level: index % 10 === 0 ? ('critical' as const) : ('high' as const),
      };
    }),
    dataset_version: 'rag-eval-v1',
    schema_version: 'rag-eval-dataset@1',
    thresholds: {
      citation_accuracy_minimum: 0.95,
      fabricated_citation_maximum: 0,
      high_risk_precision_minimum: 0.95,
      latency_p95_maximum_ms: 800,
      no_answer_accuracy_minimum: 0.95,
      precision_minimum: 0.95,
      recall_minimum: 0.95,
    },
    top_k: 5,
  };
}

function rawPredictions(): {
  dataset_version: string;
  predictions: Array<{
    case_id: string;
    citations: Array<{ chunk_id: string; quote: string; text_hash: string }>;
    latency_ms: number;
  }>;
  schema_version: string;
  system_version: string;
} {
  const dataset = rawDataset();
  return {
    dataset_version: dataset.dataset_version,
    predictions: dataset.cases.map((item, index) => ({
      case_id: item.case_id,
      citations: item.expected_evidence.map((evidence) => {
        const source = item.chunks.find((chunk_) => chunk_.chunk_id === evidence.chunk_id)!;
        return {
          chunk_id: source.chunk_id,
          quote: source.text,
          text_hash: source.text_hash,
        };
      }),
      latency_ms: 20 + (index % 40),
    })),
    schema_version: 'rag-eval-predictions@1',
    system_version: 'citation-search-v1',
  };
}

function chunk(chunkId: string, text: string) {
  return {
    chunk_id: chunkId,
    text,
    text_hash: createHash('sha256').update(text).digest('hex'),
  };
}

function baseline(): RagEvalBaseline {
  return {
    datasetSha256: DATASET_HASH,
    datasetVersion: 'rag-eval-v1',
    metrics: {
      citationAccuracy: 1,
      fabricatedCitationCount: 0,
      highRiskPrecision: 1,
      latencyP95Ms: 57,
      noAnswerAccuracy: 1,
      precision: 1,
      recall: 1,
    },
    schemaVersion: RAG_EVAL_BASELINE_SCHEMA,
    systemVersion: 'citation-search-v1',
    tolerance: { latencyRatio: 1.1, qualityAbsolute: 0.001 },
  };
}
