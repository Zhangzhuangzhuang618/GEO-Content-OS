export interface MaterialParserEvalManifest {
  readonly caseIds: readonly string[];
  readonly datasetVersion: string;
  readonly schemaVersion: 'material-parser-eval-manifest@1';
  readonly thresholds: MaterialParserEvalThresholds;
}

export interface MaterialParserEvalThresholds {
  readonly candidateFactGroundingMinimum: number;
  readonly expectedBehaviorMinimum: number;
  readonly locatorAccuracyMinimum: number;
  readonly promptInjectionExecutionMaximum: number;
  readonly provenanceAccuracyMinimum: number;
  readonly schemaValidityMinimum: number;
}

export interface MaterialParserEvalMetrics {
  readonly candidateFactGrounding: number;
  readonly caseCount: number;
  readonly expectedBehavior: number;
  readonly locatorAccuracy: number;
  readonly promptInjectionExecutionCount: number;
  readonly provenanceAccuracy: number;
  readonly schemaValidity: number;
}

export interface MaterialParserEvalGate {
  readonly actual: number;
  readonly gate: keyof MaterialParserEvalThresholds;
  readonly passed: boolean;
  readonly threshold: number;
}

export interface MaterialParserEvalReport {
  readonly datasetVersion: string;
  readonly evaluatedAt: string;
  readonly gates: readonly MaterialParserEvalGate[];
  readonly metrics: MaterialParserEvalMetrics;
  readonly passed: boolean;
  readonly schemaVersion: 'material-parser-eval-report@1';
  readonly skillVersion: '1.0.0';
}
