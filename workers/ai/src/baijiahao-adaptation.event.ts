import { DomainEventEnvelopeSchema } from '@geo-content-os/contracts';

import { GenerationWorkerError } from './generation.errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const DATA_KEYS = new Set([
  'actor_user_id',
  'adaptation_attempt',
  'automation_run_id',
  'content_version_id',
  'generation_run_id',
  'package_id',
  'project_id',
  'request_id',
  'source_content_version_id',
  'variant_id',
  'workspace_id',
]);

export interface ValidatedBaijiahaoAdaptationEvent {
  readonly data: {
    readonly actorUserId: string;
    readonly adaptationAttempt: number;
    readonly automationRunId: string;
    readonly contentVersionId: string;
    readonly generationRunId: string;
    readonly packageId: string;
    readonly projectId: string;
    readonly requestId: string;
    readonly sourceContentVersionId: string;
    readonly variantId: string;
    readonly workspaceId: string;
  };
  readonly eventId: string;
  readonly tenantId: string;
}

export function validateBaijiahaoAdaptationEvent(raw: unknown): ValidatedBaijiahaoAdaptationEvent {
  const parsed = DomainEventEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw invalid();
  const event = parsed.data;
  if (
    event.event_type !== 'content.variant.baijiahao_adaptation_requested.v1' ||
    event.aggregate.type !== 'content_variant' ||
    !record(event.data) ||
    Object.keys(event.data).some((key) => !DATA_KEYS.has(key))
  ) {
    throw invalid();
  }
  const data = {
    actorUserId: string(event.data.actor_user_id),
    adaptationAttempt: integer(event.data.adaptation_attempt),
    automationRunId: string(event.data.automation_run_id),
    contentVersionId: string(event.data.content_version_id),
    generationRunId: string(event.data.generation_run_id),
    packageId: string(event.data.package_id),
    projectId: string(event.data.project_id),
    requestId: string(event.data.request_id),
    sourceContentVersionId: string(event.data.source_content_version_id),
    variantId: string(event.data.variant_id),
    workspaceId: string(event.data.workspace_id),
  };
  if (
    event.aggregate.id !== data.variantId ||
    !REQUEST_ID.test(data.requestId) ||
    data.adaptationAttempt < 0 ||
    data.adaptationAttempt > 3 ||
    [
      data.actorUserId,
      data.automationRunId,
      data.contentVersionId,
      data.generationRunId,
      data.packageId,
      data.projectId,
      data.sourceContentVersionId,
      data.variantId,
      data.workspaceId,
    ].some((value) => !UUID.test(value))
  ) {
    throw invalid();
  }
  return Object.freeze({
    data: Object.freeze(data),
    eventId: event.event_id,
    tenantId: event.tenant.id,
  });
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function integer(value: unknown): number {
  return Number.isSafeInteger(value) ? Number(value) : -1;
}

function invalid(): GenerationWorkerError {
  return new GenerationWorkerError(
    'BAIJIAHAO_ADAPTATION_EVENT_INVALID',
    'Baijiahao adaptation event is invalid',
  );
}
