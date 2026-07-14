export const RAG_EVAL_DATASET_SCHEMA = 'rag-eval-dataset@1' as const;
export const RAG_EVAL_PREDICTIONS_SCHEMA = 'rag-eval-predictions@1' as const;
export const RAG_EVAL_REPORT_SCHEMA = 'rag-eval-report@1' as const;
export const RAG_EVAL_BASELINE_SCHEMA = 'rag-eval-baseline@1' as const;

export type RagRiskLevel = 'critical' | 'high' | 'normal';

export interface RagEvalThresholds {
  readonly citationAccuracyMinimum: number;
  readonly fabricatedCitationMaximum: number;
  readonly highRiskPrecisionMinimum: number;
  readonly latencyP95MaximumMs: number;
  readonly noAnswerAccuracyMinimum: number;
  readonly precisionMinimum: number;
  readonly recallMinimum: number;
}

export interface RagEvalChunk {
  readonly chunkId: string;
  readonly text: string;
  readonly textHash: string;
}

export interface RagExpectedEvidence {
  readonly chunkId: string;
  readonly requiredQuote: string;
}

export interface RagEvalCase {
  readonly caseId: string;
  readonly chunks: readonly RagEvalChunk[];
  readonly expectedEvidence: readonly RagExpectedEvidence[];
  readonly query: string;
  readonly riskLevel: RagRiskLevel;
}

export interface RagEvalDataset {
  readonly cases: readonly RagEvalCase[];
  readonly datasetVersion: string;
  readonly schemaVersion: typeof RAG_EVAL_DATASET_SCHEMA;
  readonly thresholds: RagEvalThresholds;
  readonly topK: number;
}

export interface RagPredictedCitation {
  readonly chunkId: string;
  readonly quote: string;
  readonly textHash: string;
}

export interface RagCasePrediction {
  readonly caseId: string;
  readonly citations: readonly RagPredictedCitation[];
  readonly latencyMs: number;
}

export interface RagEvalPredictions {
  readonly datasetVersion: string;
  readonly predictions: readonly RagCasePrediction[];
  readonly schemaVersion: typeof RAG_EVAL_PREDICTIONS_SCHEMA;
  readonly systemVersion: string;
}

export interface RagEvalMetrics {
  readonly caseCount: number;
  readonly citationAccuracy: number;
  readonly fabricatedCitationCount: number;
  readonly fabricatedCitationRate: number;
  readonly highRiskCaseCount: number;
  readonly highRiskPrecision: number;
  readonly latencyMaximumMs: number;
  readonly latencyMeanMs: number;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly noAnswerAccuracy: number;
  readonly noAnswerCaseCount: number;
  readonly precision: number;
  readonly recall: number;
  readonly returnedCitationCount: number;
}

export interface RagEvalGateResult {
  readonly actual: number;
  readonly gate: keyof RagEvalThresholds;
  readonly passed: boolean;
  readonly threshold: number;
}

export interface RagEvalReport {
  readonly datasetSha256: string;
  readonly datasetVersion: string;
  readonly evaluatedAt: string;
  readonly gates: readonly RagEvalGateResult[];
  readonly metrics: RagEvalMetrics;
  readonly passed: boolean;
  readonly schemaVersion: typeof RAG_EVAL_REPORT_SCHEMA;
  readonly systemVersion: string;
  readonly topK: number;
}

export interface RagEvalBaseline {
  readonly datasetSha256: string;
  readonly datasetVersion: string;
  readonly metrics: Pick<
    RagEvalMetrics,
    | 'citationAccuracy'
    | 'fabricatedCitationCount'
    | 'highRiskPrecision'
    | 'latencyP95Ms'
    | 'noAnswerAccuracy'
    | 'precision'
    | 'recall'
  >;
  readonly schemaVersion: typeof RAG_EVAL_BASELINE_SCHEMA;
  readonly systemVersion: string;
  readonly tolerance: {
    readonly latencyRatio: number;
    readonly qualityAbsolute: number;
  };
}
