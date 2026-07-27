import { describe, expect, it } from 'vitest';

import { GenerationWorkerError } from './generation.errors.js';
import { validateVisibilityProbeEvent } from './visibility.event.js';

const EVENT = {
  aggregate: { id: '60000000-0000-4000-8000-000000000071', type: 'visibility_run' },
  data: {
    ai_visibility_run_id: '60000000-0000-4000-8000-000000000071',
    engine_code: 'deepseek',
    model_key: 'deepseek-v4-flash',
    workspace_id: '30000000-0000-4000-8000-000000000071',
  },
  event_id: 'a0000000-0000-4000-8000-000000000071',
  event_type: 'analytics.visibility.probe_requested.v1',
  occurred_at: '2026-07-26T00:00:00.000Z',
  tenant: { id: '20000000-0000-4000-8000-000000000071' },
} as const;

describe('AI visibility event validation', () => {
  it('accepts the exact visibility run envelope', () => {
    expect(validateVisibilityProbeEvent(EVENT)).toEqual({
      data: {
        engineCode: 'deepseek',
        modelKey: 'deepseek-v4-flash',
        runId: EVENT.data.ai_visibility_run_id,
        workspaceId: EVENT.data.workspace_id,
      },
      eventId: EVENT.event_id,
      tenantId: EVENT.tenant.id,
    });
  });

  it('rejects unsupported engines and unknown fields', () => {
    expect(() =>
      validateVisibilityProbeEvent({
        ...EVENT,
        data: { ...EVENT.data, engine_code: 'browser-mcp' },
      }),
    ).toThrow(GenerationWorkerError);
    expect(() =>
      validateVisibilityProbeEvent({
        ...EVENT,
        data: { ...EVENT.data, api_key: 'must-not-be-in-events' },
      }),
    ).toThrow('AI visibility probe event is invalid');
  });
});
