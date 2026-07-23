export interface TopicPlannerEvalThresholds {
  readonly briefLinkageMinimum: number;
  readonly evidenceIntegrityMinimum: number;
  readonly expectedBehaviorMinimum: number;
  readonly noEvidenceSafetyMinimum: number;
  readonly scopeComplianceMinimum: number;
  readonly schemaValidityMinimum: number;
}
export interface TopicPlannerEvalManifest {
  readonly caseIds: readonly string[];
  readonly datasetVersion: string;
  readonly schemaVersion: 'topic-planner-eval-manifest@1';
  readonly thresholds: TopicPlannerEvalThresholds;
}
export interface TopicPlannerEvalMetrics {
  readonly briefLinkage: number;
  readonly caseCount: number;
  readonly evidenceIntegrity: number;
  readonly expectedBehavior: number;
  readonly noEvidenceSafety: number;
  readonly schemaValidity: number;
  readonly scopeCompliance: number;
}
export interface TopicPlannerEvalGate {
  readonly actual: number;
  readonly gate: keyof TopicPlannerEvalThresholds;
  readonly passed: boolean;
  readonly threshold: number;
}
export interface TopicPlannerEvalReport {
  readonly datasetVersion: string;
  readonly evaluatedAt: string;
  readonly gates: readonly TopicPlannerEvalGate[];
  readonly metrics: TopicPlannerEvalMetrics;
  readonly passed: boolean;
  readonly schemaVersion: 'topic-planner-eval-report@1';
  readonly skillVersion: '1.0.0';
}
