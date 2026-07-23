import { DomainEventEnvelopeSchema } from '@geo-content-os/contracts';

import { GenerationWorkerError } from './generation.errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const DATA_KEYS = new Set([
  'actor_user_id',
  'automation_run_id',
  'content_version_id',
  'generation_run_id',
  'package_id',
  'project_id',
  'request_id',
  'rewrite_attempt',
  'variant_id',
  'workspace_id',
]);

export interface ValidatedOfficialSiteRewriteEvent {
  readonly data: {
    readonly actorUserId: string;
    readonly automationRunId: string;
    readonly contentVersionId: string;
    readonly generationRunId: string;
    readonly packageId: string;
    readonly projectId: string;
    readonly requestId: string;
    readonly rewriteAttempt: number;
    readonly variantId: string;
    readonly workspaceId: string;
  };
  readonly eventId: string;
  readonly tenantId: string;
}

export function validateOfficialSiteRewriteEvent(raw: unknown): ValidatedOfficialSiteRewriteEvent {
  const parsed = DomainEventEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw invalidEvent();
  const event = parsed.data;
  if (
    event.event_type !== 'content.variant.official_site_rewrite_requested.v1' ||
    event.aggregate.type !== 'content_variant' ||
    !record(event.data) ||
    Object.keys(event.data).some((key) => !DATA_KEYS.has(key))
  ) {
    throw invalidEvent();
  }
  const data = event.data;
  const values = {
    actorUserId: string(data.actor_user_id),
    automationRunId: string(data.automation_run_id),
    contentVersionId: string(data.content_version_id),
    generationRunId: string(data.generation_run_id),
    packageId: string(data.package_id),
    projectId: string(data.project_id),
    requestId: string(data.request_id),
    rewriteAttempt: data.rewrite_attempt,
    variantId: string(data.variant_id),
    workspaceId: string(data.workspace_id),
  };
  if (
    event.aggregate.id !== values.variantId ||
    !REQUEST_ID.test(values.requestId) ||
    !Number.isSafeInteger(values.rewriteAttempt) ||
    Number(values.rewriteAttempt) < 1 ||
    Number(values.rewriteAttempt) > 3 ||
    [
      values.actorUserId,
      values.automationRunId,
      values.contentVersionId,
      values.generationRunId,
      values.packageId,
      values.projectId,
      values.variantId,
      values.workspaceId,
    ].some((value) => !UUID.test(value))
  ) {
    throw invalidEvent();
  }
  return Object.freeze({
    data: Object.freeze({ ...values, rewriteAttempt: Number(values.rewriteAttempt) }),
    eventId: event.event_id,
    tenantId: event.tenant.id,
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function invalidEvent(): GenerationWorkerError {
  return new GenerationWorkerError(
    'OFFICIAL_SITE_REWRITE_EVENT_INVALID',
    'Official-site rewrite event is invalid',
  );
}
