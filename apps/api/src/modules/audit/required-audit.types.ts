export interface RequiredAuditInput {
  readonly action: string;
  readonly actorId?: string | null;
  readonly after?: unknown;
  readonly before?: unknown;
  readonly ip?: string | null;
  readonly requestId: string;
  readonly resourceId?: string | null;
  readonly resourceType: string;
  readonly supportAccessGrantId?: string | null;
  readonly tenantId: string;
}

export interface AuditEventRecord {
  readonly action: string;
  readonly actorId: string | null;
  readonly after: unknown;
  readonly before: unknown;
  readonly createdAt: Date;
  readonly id: string;
  readonly ip: string | null;
  readonly requestId: string;
  readonly resourceId: string | null;
  readonly resourceType: string;
  readonly supportAccessGrantId: string | null;
  readonly tenantId: string;
}
