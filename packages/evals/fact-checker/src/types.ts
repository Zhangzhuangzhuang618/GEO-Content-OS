export interface FactCheckerEvalThresholds {
  readonly claimCoverageMinimum: number;
  readonly evidenceRuleMinimum: number;
  readonly expectedBehaviorMinimum: number;
  readonly highRiskDecisionMinimum: number;
  readonly quoteIntegrityMinimum: number;
  readonly schemaValidityMinimum: number;
}
export interface FactCheckerEvalManifest {
  readonly caseIds: readonly string[];
  readonly datasetVersion: string;
  readonly schemaVersion: 'fact-checker-eval-manifest@1';
  readonly thresholds: FactCheckerEvalThresholds;
}
export interface FactCheckerEvalMetrics {
  readonly caseCount: number;
  readonly claimCoverage: number;
  readonly evidenceRule: number;
  readonly expectedBehavior: number;
  readonly highRiskDecision: number;
  readonly quoteIntegrity: number;
  readonly schemaValidity: number;
}
export interface FactCheckerEvalGate {
  readonly actual: number;
  readonly gate: keyof FactCheckerEvalThresholds;
  readonly passed: boolean;
  readonly threshold: number;
}
export interface FactCheckerEvalReport {
  readonly datasetVersion: string;
  readonly evaluatedAt: string;
  readonly gates: readonly FactCheckerEvalGate[];
  readonly metrics: FactCheckerEvalMetrics;
  readonly passed: boolean;
  readonly schemaVersion: 'fact-checker-eval-report@1';
  readonly skillVersion: '1.0.0';
}
