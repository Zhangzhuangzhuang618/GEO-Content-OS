export interface QualityCheckerEvalThresholds {
  readonly decisionGateMinimum: number;
  readonly expectedBehaviorMinimum: number;
  readonly geoIntegrityMinimum: number;
  readonly hardRuleMinimum: number;
  readonly schemaValidityMinimum: number;
}
export interface QualityCheckerEvalManifest {
  readonly caseIds: readonly string[];
  readonly datasetVersion: string;
  readonly schemaVersion: 'quality-checker-eval-manifest@1';
  readonly thresholds: QualityCheckerEvalThresholds;
}
export interface QualityCheckerEvalMetrics {
  readonly caseCount: number;
  readonly decisionGate: number;
  readonly expectedBehavior: number;
  readonly geoIntegrity: number;
  readonly hardRule: number;
  readonly schemaValidity: number;
}
export interface QualityCheckerEvalGate {
  readonly actual: number;
  readonly gate: keyof QualityCheckerEvalThresholds;
  readonly passed: boolean;
  readonly threshold: number;
}
export interface QualityCheckerEvalReport {
  readonly datasetVersion: string;
  readonly evaluatedAt: string;
  readonly gates: readonly QualityCheckerEvalGate[];
  readonly metrics: QualityCheckerEvalMetrics;
  readonly passed: boolean;
  readonly schemaVersion: 'quality-checker-eval-report@1';
  readonly skillVersion: '1.0.0';
}
