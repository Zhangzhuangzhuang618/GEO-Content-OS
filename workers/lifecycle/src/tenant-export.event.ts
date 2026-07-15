import { createDomainEventSchema, IsoDateTimeSchema, UuidSchema } from '@geo-content-os/contracts';
import { z } from 'zod';

const TenantExportDataSchema = z
  .object({
    expires_at: IsoDateTimeSchema,
    tenant_export_job_id: UuidSchema,
  })
  .strict();

const TenantExportEventSchema = createDomainEventSchema(TenantExportDataSchema).refine(
  (event) =>
    event.event_type === 'lifecycle.tenant.export_requested.v1' &&
    event.aggregate.type === 'tenant_export_job' &&
    event.aggregate.id === event.data.tenant_export_job_id,
  { message: 'Tenant export event routing is invalid' },
);

export interface TenantExportEvent {
  readonly eventId: string;
  readonly expiresAt: string;
  readonly exportJobId: string;
  readonly occurredAt: string;
  readonly tenantId: string;
}

export function parseTenantExportEvent(value: unknown): TenantExportEvent {
  const event = TenantExportEventSchema.safeParse(value);
  if (!event.success) throw new TenantExportWorkerError('Tenant export event is invalid');
  return Object.freeze({
    eventId: event.data.event_id,
    expiresAt: event.data.data.expires_at,
    exportJobId: event.data.data.tenant_export_job_id,
    occurredAt: event.data.occurred_at,
    tenantId: event.data.tenant.id,
  });
}

export class TenantExportWorkerError extends Error {}
