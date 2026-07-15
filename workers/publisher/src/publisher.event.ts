import { DomainEventEnvelopeSchema } from '@geo-content-os/contracts';

import { PublisherError } from './publisher.errors.js';
import type { ValidatedPublishEvent } from './publisher.types.js';

const ALLOWED_KEYS = new Set(['job_id', 'job_version', 'request_id', 'scheduled_at']);

export function validatePublishEvent(raw: unknown): ValidatedPublishEvent {
  const parsed = DomainEventEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw invalid();
  const event = parsed.data;
  if (
    event.event_type !== 'publishing.job.execution_requested.v1' ||
    event.aggregate.type !== 'publish_job' ||
    !isRecord(event.data) ||
    Object.keys(event.data).some((key) => !ALLOWED_KEYS.has(key))
  ) {
    throw invalid();
  }
  const jobId = stringValue(event.data.job_id);
  const jobVersion = event.data.job_version;
  const requestId = stringValue(event.data.request_id);
  const scheduledAt = stringValue(event.data.scheduled_at);
  if (
    jobId !== event.aggregate.id ||
    !Number.isInteger(jobVersion) ||
    Number(jobVersion) < 1 ||
    requestId.length < 1 ||
    requestId.length > 80 ||
    !validDate(scheduledAt)
  ) {
    throw invalid();
  }
  return Object.freeze({
    eventId: event.event_id,
    jobId,
    jobVersion: Number(jobVersion),
    occurredAt: event.occurred_at,
    requestId,
    scheduledAt,
    tenantId: event.tenant.id,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function validDate(value: string): boolean {
  return value.length > 0 && Number.isFinite(new Date(value).getTime());
}

function invalid(): PublisherError {
  return new PublisherError('PUBLISHER_EVENT_INVALID', 'Publish event is invalid');
}
