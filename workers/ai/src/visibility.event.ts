import { DomainEventEnvelopeSchema } from '@geo-content-os/contracts';

import { GenerationWorkerError } from './generation.errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MODEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const DATA_KEYS = new Set(['ai_visibility_run_id', 'engine_code', 'model_key', 'workspace_id']);

export interface ValidatedVisibilityProbeEvent {
  readonly data: {
    readonly engineCode: 'deepseek';
    readonly modelKey: string;
    readonly runId: string;
    readonly workspaceId: string;
  };
  readonly eventId: string;
  readonly tenantId: string;
}

export function validateVisibilityProbeEvent(raw: unknown): ValidatedVisibilityProbeEvent {
  const parsed = DomainEventEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw invalidEvent();
  const event = parsed.data;
  if (
    event.event_type !== 'analytics.visibility.probe_requested.v1' ||
    event.aggregate.type !== 'visibility_run' ||
    !record(event.data) ||
    Object.keys(event.data).some((key) => !DATA_KEYS.has(key))
  ) {
    throw invalidEvent();
  }
  const values = {
    engineCode: string(event.data.engine_code),
    modelKey: string(event.data.model_key),
    runId: string(event.data.ai_visibility_run_id),
    workspaceId: string(event.data.workspace_id),
  };
  if (
    event.aggregate.id !== values.runId ||
    values.engineCode !== 'deepseek' ||
    !MODEL_KEY.test(values.modelKey) ||
    !UUID.test(values.runId) ||
    !UUID.test(values.workspaceId)
  ) {
    throw invalidEvent();
  }
  return Object.freeze({
    data: Object.freeze({
      engineCode: 'deepseek' as const,
      modelKey: values.modelKey,
      runId: values.runId,
      workspaceId: values.workspaceId,
    }),
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
    'VISIBILITY_EVENT_INVALID',
    'AI visibility probe event is invalid',
  );
}
