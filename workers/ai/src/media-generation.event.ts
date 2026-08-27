import { DomainEventEnvelopeSchema } from '@geo-content-os/contracts';

import { GenerationWorkerError } from './generation.errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[0-9a-f]{64}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const DATA_KEYS = new Set([
  'actor_user_id',
  'content_hash',
  'content_version_id',
  'media_run_id',
  'package_id',
  'platform_code',
  'project_id',
  'publish_job_id',
  'quality_report_id',
  'request_id',
  'source_publish_job_id',
  'validation_mode',
  'variant_id',
  'workspace_id',
]);

export interface ValidatedMediaGenerationEvent {
  readonly data: {
    readonly actorUserId: string;
    readonly contentHash: string;
    readonly contentVersionId: string;
    readonly mediaRunId: string;
    readonly packageId: string;
    readonly platformCode: 'baijiahao' | 'douyin' | 'lieju' | 'official_site' | 'sohu';
    readonly projectId: string;
    readonly publishJobId: string | null;
    readonly qualityReportId: string;
    readonly requestId: string;
    readonly sourcePublishJobId?: string | null;
    readonly validationMode?: 'full' | 'manual_edit';
    readonly variantId: string;
    readonly workspaceId: string;
  };
  readonly eventId: string;
  readonly tenantId: string;
}

export function validateMediaGenerationEvent(raw: unknown): ValidatedMediaGenerationEvent {
  const parsed = DomainEventEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw invalid();
  const event = parsed.data;
  if (
    event.event_type !== 'content.variant.media_generation_requested.v1' ||
    event.aggregate.type !== 'content_media_run' ||
    !record(event.data) ||
    Object.keys(event.data).some((key) => !DATA_KEYS.has(key))
  ) {
    throw invalid();
  }
  const data = {
    actorUserId: string(event.data.actor_user_id),
    contentHash: string(event.data.content_hash),
    contentVersionId: string(event.data.content_version_id),
    mediaRunId: string(event.data.media_run_id),
    packageId: string(event.data.package_id),
    platformCode: string(event.data.platform_code),
    projectId: string(event.data.project_id),
    publishJobId: optionalString(event.data.publish_job_id),
    qualityReportId: string(event.data.quality_report_id),
    requestId: string(event.data.request_id),
    sourcePublishJobId: optionalString(event.data.source_publish_job_id),
    validationMode:
      event.data.validation_mode === undefined ? 'full' : string(event.data.validation_mode),
    variantId: string(event.data.variant_id),
    workspaceId: string(event.data.workspace_id),
  };
  if (
    event.aggregate.id !== data.mediaRunId ||
    !HASH.test(data.contentHash) ||
    !REQUEST_ID.test(data.requestId) ||
    (data.validationMode !== 'full' && data.validationMode !== 'manual_edit') ||
    (data.validationMode === 'manual_edit'
      ? !data.sourcePublishJobId || !UUID.test(data.sourcePublishJobId)
      : data.sourcePublishJobId !== null) ||
    !['official_site', 'baijiahao', 'sohu', 'lieju', 'douyin'].includes(data.platformCode) ||
    [
      data.actorUserId,
      data.contentVersionId,
      data.mediaRunId,
      data.packageId,
      data.projectId,
      ...(data.publishJobId ? [data.publishJobId] : []),
      data.qualityReportId,
      data.variantId,
      data.workspaceId,
    ].some((value) => !UUID.test(value))
  ) {
    throw invalid();
  }
  return Object.freeze({
    data: Object.freeze({
      ...data,
      platformCode: data.platformCode as
        'baijiahao' | 'douyin' | 'lieju' | 'official_site' | 'sohu',
      validationMode: data.validationMode as 'full' | 'manual_edit',
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

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function invalid(): GenerationWorkerError {
  return new GenerationWorkerError(
    'MEDIA_GENERATION_EVENT_INVALID',
    'Content media generation event is invalid',
  );
}
