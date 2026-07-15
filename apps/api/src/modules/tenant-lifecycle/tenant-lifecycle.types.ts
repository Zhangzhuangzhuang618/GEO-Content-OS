export interface TenantLifecycleScope {
  readonly requestId: string;
  readonly tenantId: string;
  readonly userId: string;
}

export interface TenantExportJobView {
  readonly createdAt: Date;
  readonly error: Readonly<Record<string, unknown>> | null;
  readonly expiresAt: Date | null;
  readonly id: string;
  readonly manifestHash: string | null;
  readonly objectUri: string | null;
  readonly requestedBy: string;
  readonly status: 'expired' | 'failed' | 'queued' | 'running' | 'succeeded';
  readonly tenantId: string;
  readonly updatedAt: Date;
}

export interface TenantDeletionPlan {
  readonly objectUris: readonly string[];
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly tenantId: string;
  readonly totalRows: number;
}
