export interface GeoOptimizerEvalThresholds {
  readonly citationIntegrityMinimum: number;
  readonly expectedBehaviorMinimum: number;
  readonly lockIntegrityMinimum: number;
  readonly rewritePlanIntegrityMinimum: number;
  readonly schemaValidityMinimum: number;
  readonly weightedScoreMinimum: number;
}

export interface GeoOptimizerEvalManifest {
  readonly caseIds: readonly string[];
  readonly datasetVersion: string;
  readonly schemaVersion: 'geo-optimizer-eval-manifest@1';
  readonly thresholds: GeoOptimizerEvalThresholds;
}

export interface GeoOptimizerEvalMetrics {
  readonly caseCount: number;
  readonly citationIntegrity: number;
  readonly expectedBehavior: number;
  readonly lockIntegrity: number;
  readonly rewritePlanIntegrity: number;
  readonly schemaValidity: number;
  readonly weightedScore: number;
}

export interface GeoOptimizerEvalGate {
  readonly actual: number;
  readonly gate: keyof GeoOptimizerEvalThresholds;
  readonly passed: boolean;
  readonly threshold: number;
}

export interface GeoOptimizerEvalReport {
  readonly datasetVersion: string;
  readonly evaluatedAt: string;
  readonly gates: readonly GeoOptimizerEvalGate[];
  readonly metrics: GeoOptimizerEvalMetrics;
  readonly passed: boolean;
  readonly schemaVersion: 'geo-optimizer-eval-report@1';
  readonly skillVersion: '1.0.0';
}
