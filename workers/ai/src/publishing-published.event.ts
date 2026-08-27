import {
  DomainEventEnvelopeSchema,
  PLATFORM_CODES,
  type PlatformCode,
} from '@geo-content-os/contracts';

import { GenerationWorkerError } from './generation.errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const DATA_KEYS = new Set([
  'account_id',
  'content_version_id',
  'created_by',
  'external_post_id',
  'external_url',
  'job_id',
  'job_version',
  'origin',
  'package_id',
  'platform_code',
  'project_id',
  'published_at',
  'request_id',
  'variant_id',
  'workspace_id',
]);

export interface ValidatedPublishingPublishedEvent {
  readonly data: {
    readonly accountId: string;
    readonly contentVersionId: string;
    readonly createdBy: string;
    readonly externalPostId: string;
    readonly externalUrl: string | null;
    readonly jobId: string;
    readonly jobVersion: number;
    readonly origin:
      | 'baijiahao_automation'
      | 'douyin_automation'
      | 'lieju_automation'
      | 'manual'
      | 'official_site_automation'
      | 'sohu_automation';
    readonly packageId: string;
    readonly platformCode: PlatformCode;
    readonly projectId: string;
    readonly publishedAt: string;
    readonly requestId: string;
    readonly variantId: string;
    readonly workspaceId: string;
  };
  readonly eventId: string;
  readonly tenantId: string;
}

export function validatePublishingPublishedEvent(raw: unknown): ValidatedPublishingPublishedEvent {
  const parsed = DomainEventEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw invalid();
  const event = parsed.data;
  if (
    event.event_type !== 'publishing.job.published.v1' ||
    event.aggregate.type !== 'publish_job' ||
    !record(event.data) ||
    Object.keys(event.data).some((key) => !DATA_KEYS.has(key))
  ) {
    throw invalid();
  }
  const data = {
    accountId: string(event.data.account_id),
    contentVersionId: string(event.data.content_version_id),
    createdBy: string(event.data.created_by),
    externalPostId: string(event.data.external_post_id),
    externalUrl: nullableString(event.data.external_url),
    jobId: string(event.data.job_id),
    jobVersion: integer(event.data.job_version),
    origin: string(event.data.origin),
    packageId: string(event.data.package_id),
    platformCode: string(event.data.platform_code),
    projectId: string(event.data.project_id),
    publishedAt: string(event.data.published_at),
    requestId: string(event.data.request_id),
    variantId: string(event.data.variant_id),
    workspaceId: string(event.data.workspace_id),
  };
  if (
    data.jobId !== event.aggregate.id ||
    !REQUEST_ID.test(data.requestId) ||
    data.jobVersion < 1 ||
    !PLATFORM_CODES.includes(data.platformCode as PlatformCode) ||
    ![
      'manual',
      'official_site_automation',
      'baijiahao_automation',
      'douyin_automation',
      'sohu_automation',
      'lieju_automation',
    ].includes(data.origin) ||
    (data.externalUrl !== null && !validUrl(data.externalUrl)) ||
    !validDate(data.publishedAt) ||
    data.externalPostId.length < 1 ||
    data.externalPostId.length > 240 ||
    [
      data.accountId,
      data.contentVersionId,
      data.createdBy,
      data.jobId,
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
      origin: data.origin as ValidatedPublishingPublishedEvent['data']['origin'],
      platformCode: data.platformCode as PlatformCode,
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

function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}

function integer(value: unknown): number {
  return Number.isSafeInteger(value) ? Number(value) : 0;
}

function validDate(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

function validUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function invalid(): GenerationWorkerError {
  return new GenerationWorkerError(
    'PUBLISHING_PUBLISHED_EVENT_INVALID',
    'Publishing published event is invalid',
  );
}
