import { DomainEventEnvelopeSchema } from '@geo-content-os/contracts';

export interface MetricsImportEvent {
  readonly contentHash: string;
  readonly eventId: string;
  readonly importJobId: string;
  readonly objectKey: string;
  readonly tenantId: string;
  readonly workspaceId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[0-9a-f]{64}$/u;
const KEYS = new Set(['content_hash', 'import_job_id', 'object_key', 'workspace_id']);

export function validateMetricsImportEvent(raw: unknown): MetricsImportEvent {
  const parsed = DomainEventEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw new MetricsImportWorkerError('Metrics import event is invalid');
  const event = parsed.data;
  if (
    event.event_type !== 'analytics.metrics.import_requested.v1' ||
    event.aggregate.type !== 'import_job' ||
    !record(event.data) ||
    Object.keys(event.data).some((key) => !KEYS.has(key))
  ) {
    throw new MetricsImportWorkerError('Metrics import event is invalid');
  }
  const contentHash = string(event.data['content_hash']);
  const importJobId = string(event.data['import_job_id']);
  const objectKey = string(event.data['object_key']);
  const workspaceId = string(event.data['workspace_id']);
  if (
    !HASH.test(contentHash) ||
    !UUID.test(importJobId) ||
    importJobId !== event.aggregate.id ||
    !UUID.test(workspaceId) ||
    !safeObjectKey(objectKey)
  ) {
    throw new MetricsImportWorkerError('Metrics import event is invalid');
  }
  return Object.freeze({
    contentHash,
    eventId: event.event_id,
    importJobId,
    objectKey,
    tenantId: event.tenant.id,
    workspaceId,
  });
}

export class MetricsImportWorkerError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function safeObjectKey(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1_024 &&
    !value.startsWith('/') &&
    !value.includes('..') &&
    /^[A-Za-z0-9][A-Za-z0-9/_=.-]*$/u.test(value)
  );
}
