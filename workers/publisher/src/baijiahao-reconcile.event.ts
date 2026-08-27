import { DomainEventEnvelopeSchema } from '@geo-content-os/contracts';

import { PublisherError } from './publisher.errors.js';
import type { ValidatedBaijiahaoReconcileEvent } from './publisher.types.js';

const ALLOWED_KEYS = new Set([
  'account_id',
  'external_post_id',
  'job_id',
  'job_version',
  'reconcile_attempt',
  'request_id',
]);

export function validateBaijiahaoReconcileEvent(raw: unknown): ValidatedBaijiahaoReconcileEvent {
  const parsed = DomainEventEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw invalid();
  const event = parsed.data;
  if (
    ![
      'baijiahao.publication.reconcile_requested.v1',
      'sohu.publication.reconcile_requested.v1',
      'lieju.publication.reconcile_requested.v1',
      'douyin.publication.reconcile_requested.v1',
    ].includes(event.event_type) ||
    event.aggregate.type !== 'publish_job' ||
    !isRecord(event.data) ||
    Object.keys(event.data).some((key) => !ALLOWED_KEYS.has(key))
  ) {
    throw invalid();
  }
  const jobId = stringValue(event.data.job_id);
  const jobVersion = numberValue(event.data.job_version);
  const reconcileAttempt = numberValue(event.data.reconcile_attempt);
  const requestId = stringValue(event.data.request_id);
  if (
    jobId !== event.aggregate.id ||
    jobVersion < 1 ||
    reconcileAttempt < 1 ||
    reconcileAttempt > 12 ||
    requestId.length < 1 ||
    requestId.length > 80
  ) {
    throw invalid();
  }
  return Object.freeze({
    eventId: event.event_id,
    jobId,
    jobVersion,
    occurredAt: event.occurred_at,
    reconcileAttempt,
    requestId,
    platformCode: event.event_type.startsWith('douyin.')
      ? 'douyin'
      : event.event_type.startsWith('sohu.')
        ? 'sohu'
        : event.event_type.startsWith('lieju.')
          ? 'lieju'
          : 'baijiahao',
    tenantId: event.tenant.id,
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return Number.isSafeInteger(value) ? Number(value) : 0;
}

function invalid(): PublisherError {
  return new PublisherError(
    'PUBLISHER_EVENT_INVALID',
    'Browser publication reconciliation event is invalid',
  );
}
