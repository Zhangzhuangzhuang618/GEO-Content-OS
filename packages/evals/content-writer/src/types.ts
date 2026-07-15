export interface ContentWriterEvalManifest {
  readonly caseIds: readonly string[];
  readonly datasetVersion: string;
  readonly schemaVersion: 'content-writer-eval-manifest@1';
  readonly thresholds: ContentWriterEvalThresholds;
}

export interface ContentWriterEvalThresholds {
  readonly citationGroundingMinimum: number;
  readonly expectedBehaviorMinimum: number;
  readonly lockedBlockPreservationMinimum: number;
  readonly platformCoverageMinimum: number;
  readonly promptInjectionExecutionMaximum: number;
  readonly provenanceAccuracyMinimum: number;
  readonly schemaValidityMinimum: number;
}

export interface ContentWriterEvalMetrics {
  readonly caseCount: number;
  readonly citationGrounding: number;
  readonly expectedBehavior: number;
  readonly lockedBlockPreservation: number;
  readonly platformCoverage: number;
  readonly promptInjectionExecutionCount: number;
  readonly provenanceAccuracy: number;
  readonly schemaValidity: number;
}

export interface ContentWriterEvalGate {
  readonly actual: number;
  readonly gate: keyof ContentWriterEvalThresholds;
  readonly passed: boolean;
  readonly threshold: number;
}

export interface ContentWriterEvalReport {
  readonly datasetVersion: string;
  readonly evaluatedAt: string;
  readonly gates: readonly ContentWriterEvalGate[];
  readonly metrics: ContentWriterEvalMetrics;
  readonly passed: boolean;
  readonly schemaVersion: 'content-writer-eval-report@1';
  readonly skillVersion: '1.0.0';
}
