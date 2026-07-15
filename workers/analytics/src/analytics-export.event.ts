import { createDomainEventSchema, UuidSchema } from '@geo-content-os/contracts';
import { z } from 'zod';

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const AnalyticsExportDataSchema = z
  .object({
    analytics_export_job_id: UuidSchema,
    query_hash: HashSchema,
    workspace_id: UuidSchema,
  })
  .strict();

const AnalyticsExportEventSchema = createDomainEventSchema(AnalyticsExportDataSchema).refine(
  (event) =>
    event.event_type === 'analytics.export.requested.v1' &&
    event.aggregate.type === 'analytics_export_job' &&
    event.aggregate.id === event.data.analytics_export_job_id,
  { message: 'Analytics export event routing is invalid' },
);

export interface AnalyticsExportEvent {
  readonly eventId: string;
  readonly exportJobId: string;
  readonly occurredAt: string;
  readonly queryHash: string;
  readonly tenantId: string;
  readonly workspaceId: string;
}

export function parseAnalyticsExportEvent(value: unknown): AnalyticsExportEvent {
  const parsed = AnalyticsExportEventSchema.safeParse(value);
  if (!parsed.success) throw new AnalyticsExportWorkerError('Analytics export event is invalid');
  return Object.freeze({
    eventId: parsed.data.event_id,
    exportJobId: parsed.data.data.analytics_export_job_id,
    occurredAt: parsed.data.occurred_at,
    queryHash: parsed.data.data.query_hash,
    tenantId: parsed.data.tenant.id,
    workspaceId: parsed.data.data.workspace_id,
  });
}

export class AnalyticsExportWorkerError extends Error {}
