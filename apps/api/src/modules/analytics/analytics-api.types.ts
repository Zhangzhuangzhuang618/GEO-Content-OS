export interface AnalyticsApiScope {
  readonly requestId: string;
  readonly tenantId: string;
  readonly userId: string;
}

export interface AnalyticsExportJobView {
  readonly contentHash: string | null;
  readonly createdAt: Date;
  readonly error: Readonly<Record<string, unknown>> | null;
  readonly expiresAt: Date | null;
  readonly id: string;
  readonly objectUri: string | null;
  readonly queryHash: string;
  readonly requestedBy: string;
  readonly rowCount: number | null;
  readonly status: 'expired' | 'failed' | 'queued' | 'running' | 'succeeded';
  readonly tenantId: string;
  readonly updatedAt: Date;
  readonly version: number;
  readonly workspaceId: string | null;
}

export interface ImportJobView {
  readonly contentHash: string | null;
  readonly createdAt: Date;
  readonly error: Readonly<Record<string, unknown>> | null;
  readonly id: string;
  readonly rowCount: number | null;
  readonly source: 'api' | 'csv' | 'manual';
  readonly status: 'failed' | 'queued' | 'rolled_back' | 'running' | 'succeeded';
  readonly updatedAt: Date;
  readonly workspaceId: string;
}

export interface MetricRecordView {
  readonly accountId: string | null;
  readonly createdAt: Date;
  readonly id: string;
  readonly importJobId: string;
  readonly metricDate: string;
  readonly metricName: string;
  readonly metricValue: number;
  readonly platformCode: string;
  readonly source: 'api' | 'csv' | 'manual';
  readonly tenantId: string;
  readonly variantId: string | null;
  readonly workspaceId: string;
}
