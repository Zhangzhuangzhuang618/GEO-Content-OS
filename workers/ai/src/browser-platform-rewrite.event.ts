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
  'platform_code',
  'project_id',
  'request_id',
  'rewrite_attempt',
  'variant_id',
  'workspace_id',
]);

export interface ValidatedBrowserPlatformRewriteEvent {
  readonly data: {
    readonly actorUserId: string;
    readonly automationRunId: string;
    readonly contentVersionId: string;
    readonly generationRunId: string;
    readonly packageId: string;
    readonly platformCode: 'lieju' | 'sohu';
    readonly projectId: string;
    readonly requestId: string;
    readonly rewriteAttempt: number;
    readonly variantId: string;
    readonly workspaceId: string;
  };
  readonly eventId: string;
  readonly tenantId: string;
}

export function validateBrowserPlatformRewriteEvent(
  raw: unknown,
): ValidatedBrowserPlatformRewriteEvent {
  const parsed = DomainEventEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw invalid();
  const event = parsed.data;
  if (
    event.event_type !== 'content.variant.browser_platform_rewrite_requested.v1' ||
    event.aggregate.type !== 'content_variant' ||
    !record(event.data) ||
    Object.keys(event.data).some((key) => !DATA_KEYS.has(key))
  ) {
    throw invalid();
  }
  const data = {
    actorUserId: string(event.data.actor_user_id),
    automationRunId: string(event.data.automation_run_id),
    contentVersionId: string(event.data.content_version_id),
    generationRunId: string(event.data.generation_run_id),
    packageId: string(event.data.package_id),
    platformCode: string(event.data.platform_code),
    projectId: string(event.data.project_id),
    requestId: string(event.data.request_id),
    rewriteAttempt: integer(event.data.rewrite_attempt),
    variantId: string(event.data.variant_id),
    workspaceId: string(event.data.workspace_id),
  };
  if (
    event.aggregate.id !== data.variantId ||
    !['lieju', 'sohu'].includes(data.platformCode) ||
    !REQUEST_ID.test(data.requestId) ||
    data.rewriteAttempt < 1 ||
    data.rewriteAttempt > 3 ||
    [
      data.actorUserId,
      data.automationRunId,
      data.contentVersionId,
      data.generationRunId,
      data.packageId,
      data.projectId,
      data.variantId,
      data.workspaceId,
    ].some((value) => !UUID.test(value))
  ) {
    throw invalid();
  }
  return Object.freeze({
    data: Object.freeze({
      ...data,
      platformCode: data.platformCode as 'lieju' | 'sohu',
    }),
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
    'BROWSER_PLATFORM_REWRITE_EVENT_INVALID',
    'Browser platform rewrite event is invalid',
  );
}
