import { z } from 'zod';

import { IsoDateTimeSchema, UuidSchema } from './api/common.js';

export const EVENT_TYPES = Object.freeze([
  'knowledge.source.ingest_requested.v1',
  'knowledge.source.reindex_requested.v1',
  'strategy.topic_plan.generation_requested.v1',
  'content.package.generation_requested.v1',
  'content.variant.quality_check_requested.v1',
  'publishing.job.execution_requested.v1',
  'analytics.metrics.import_requested.v1',
  'lifecycle.tenant.export_requested.v1',
] as const);

export type EventType = (typeof EVENT_TYPES)[number];

export const AGGREGATE_TYPES = Object.freeze([
  'tenant',
  'source_document',
  'generation_run',
  'content_package',
  'content_variant',
  'publish_job',
  'import_job',
  'tenant_export_job',
] as const);

export type AggregateType = (typeof AGGREGATE_TYPES)[number];

export const EventTypeSchema = z.enum(EVENT_TYPES);
export const AggregateTypeSchema = z.enum(AGGREGATE_TYPES);

export const DomainEventEnvelopeSchema = z
  .object({
    event_id: UuidSchema,
    event_type: EventTypeSchema,
    tenant: z.object({ id: UuidSchema }).strict(),
    aggregate: z
      .object({
        type: AggregateTypeSchema,
        id: UuidSchema,
      })
      .strict(),
    data: z.json(),
    occurred_at: IsoDateTimeSchema,
  })
  .strict();

export type DomainEventEnvelope = z.infer<typeof DomainEventEnvelopeSchema>;

export function createDomainEventSchema<TSchema extends z.ZodType>(dataSchema: TSchema) {
  return DomainEventEnvelopeSchema.extend({ data: dataSchema });
}
