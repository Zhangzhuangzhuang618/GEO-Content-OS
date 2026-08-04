import {
  ContentDocumentSchema,
  DomainEventEnvelopeSchema,
  PLATFORM_CODES,
} from '@geo-content-os/contracts';

import { GenerationWorkerError } from './generation.errors.js';
import type {
  GenerationEventData,
  GeneratedContent,
  JsonObject,
  ValidatedGenerationEvent,
  VariantGenerationRun,
} from './generation.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[0-9a-f]{64}$/u;
const MODEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const DATA_KEYS = new Set([
  'actor_user_id',
  'input_hash',
  'master_run_id',
  'model_key',
  'model_policy',
  'package_id',
  'project_id',
  'prompt_version_id',
  'request_id',
  'revision',
  'skill_version',
  'variant_runs',
  'workspace_id',
  'writer_input',
]);
const VARIANT_KEYS = new Set(['platform_code', 'run_id', 'variant_id']);
const REVISION_KEYS = new Set(['candidate', 'content_version_id', 'issues', 'quality_report_id']);
const REVISION_CANDIDATE_KEYS = new Set(['master_content', 'variants']);
const PLATFORM_SET = new Set<string>(PLATFORM_CODES);

export function validateGenerationEvent(raw: unknown): ValidatedGenerationEvent {
  const parsed = DomainEventEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw invalidEvent();
  const event = parsed.data;
  if (
    event.event_type !== 'content.package.generation_requested.v1' ||
    event.aggregate.type !== 'content_package' ||
    !isRecord(event.data) ||
    Object.keys(event.data).some((key) => !DATA_KEYS.has(key))
  ) {
    throw invalidEvent();
  }
  const data = event.data;
  const packageId = string(data.package_id);
  const modelPolicy = data.model_policy === undefined ? 'balanced' : string(data.model_policy);
  const variantRuns = parseVariantRuns(data.variant_runs);
  const revision = parseRevision(data.revision, variantRuns);
  const writerInput = data.writer_input;
  if (
    !UUID.test(packageId) ||
    packageId !== event.aggregate.id ||
    !UUID.test(string(data.actor_user_id)) ||
    !UUID.test(string(data.master_run_id)) ||
    !UUID.test(string(data.project_id)) ||
    !UUID.test(string(data.prompt_version_id)) ||
    !UUID.test(string(data.workspace_id)) ||
    !HASH.test(string(data.input_hash)) ||
    !MODEL_KEY.test(string(data.model_key)) ||
    !['fast', 'balanced', 'quality'].includes(modelPolicy) ||
    !REQUEST_ID.test(string(data.request_id)) ||
    !SEMVER.test(string(data.skill_version)) ||
    !isJsonObject(writerInput) ||
    containsTenantId(writerInput)
  ) {
    throw invalidEvent();
  }
  const ids = new Set(variantRuns.flatMap((item) => [item.runId, item.variantId]));
  if (ids.size !== variantRuns.length * 2) throw invalidEvent();
  const normalized: GenerationEventData = Object.freeze({
    actorUserId: string(data.actor_user_id),
    inputHash: string(data.input_hash),
    masterRunId: string(data.master_run_id),
    modelKey: string(data.model_key),
    modelPolicy: modelPolicy as GenerationEventData['modelPolicy'],
    packageId,
    projectId: string(data.project_id),
    promptVersionId: string(data.prompt_version_id),
    requestId: string(data.request_id),
    ...(revision ? { revision } : {}),
    skillVersion: string(data.skill_version),
    variantRuns: Object.freeze(variantRuns),
    workspaceId: string(data.workspace_id),
    writerInput,
  });
  return Object.freeze({
    data: normalized,
    eventId: event.event_id,
    occurredAt: event.occurred_at,
    tenantId: event.tenant.id,
  });
}

function parseRevision(
  value: unknown,
  variantRuns: readonly VariantGenerationRun[],
): GenerationEventData['revision'] {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !REVISION_KEYS.has(key)) ||
    !UUID.test(string(value.quality_report_id)) ||
    !UUID.test(string(value.content_version_id)) ||
    !Array.isArray(value.issues) ||
    value.issues.length < 1 ||
    value.issues.length > 50 ||
    value.issues.some(
      (issue) => typeof issue !== 'string' || issue.trim().length < 1 || issue.length > 4_000,
    ) ||
    containsTenantId(value) ||
    !isRecord(value.candidate) ||
    Object.keys(value.candidate).some((key) => !REVISION_CANDIDATE_KEYS.has(key)) ||
    variantRuns.length !== 1 ||
    !Array.isArray(value.candidate.variants) ||
    value.candidate.variants.length !== 1
  ) {
    throw invalidEvent();
  }
  const master = ContentDocumentSchema.safeParse(value.candidate.master_content);
  const variant = ContentDocumentSchema.safeParse(value.candidate.variants[0]);
  if (
    !master.success ||
    !variant.success ||
    master.data.platform_code !== 'master' ||
    variant.data.platform_code !== variantRuns[0]?.platformCode
  ) {
    throw invalidEvent();
  }
  return Object.freeze({
    candidate: Object.freeze({
      master_content: master.data as unknown as GeneratedContent,
      variants: Object.freeze([variant.data as unknown as GeneratedContent]),
    }),
    contentVersionId: string(value.content_version_id),
    issues: Object.freeze(value.issues.map((issue) => (issue as string).trim())),
    qualityReportId: string(value.quality_report_id),
  });
}

function parseVariantRuns(value: unknown): readonly VariantGenerationRun[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 7) throw invalidEvent();
  return value.map((candidate) => {
    if (!isRecord(candidate) || Object.keys(candidate).some((key) => !VARIANT_KEYS.has(key))) {
      throw invalidEvent();
    }
    const platformCode = string(candidate.platform_code);
    const runId = string(candidate.run_id);
    const variantId = string(candidate.variant_id);
    if (!PLATFORM_SET.has(platformCode) || !UUID.test(runId) || !UUID.test(variantId)) {
      throw invalidEvent();
    }
    return Object.freeze({
      platformCode: platformCode as VariantGenerationRun['platformCode'],
      runId,
      variantId,
    });
  });
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!isRecord(value)) return false;
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

function containsTenantId(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsTenantId);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, child]) => key === 'tenant_id' || containsTenantId(child),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function invalidEvent(): GenerationWorkerError {
  return new GenerationWorkerError('GENERATION_EVENT_INVALID', 'Generation event is invalid');
}
