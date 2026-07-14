import { describe, expect, it } from 'vitest';

import { GenerationWorkerError } from './generation.errors.js';
import { validateGenerationEvent } from './generation.event.js';

const EVENT = {
  aggregate: { id: '60000000-0000-4000-8000-000000000053', type: 'content_package' },
  data: {
    actor_user_id: '10000000-0000-4000-8000-000000000053',
    input_hash: 'a'.repeat(64),
    master_run_id: '80000000-0000-4000-8000-000000000053',
    model_key: 'deepseek-flash',
    package_id: '60000000-0000-4000-8000-000000000053',
    project_id: '40000000-0000-4000-8000-000000000053',
    prompt_version_id: '90000000-0000-4000-8000-000000000053',
    request_id: 'generation-request-53',
    skill_version: '1.0.0',
    variant_runs: [
      {
        platform_code: 'zhihu',
        run_id: '81000000-0000-4000-8000-000000000053',
        variant_id: '71000000-0000-4000-8000-000000000053',
      },
    ],
    workspace_id: '30000000-0000-4000-8000-000000000053',
    writer_input: { generation_mode: 'draft' },
  },
  event_id: 'a0000000-0000-4000-8000-000000000053',
  event_type: 'content.package.generation_requested.v1',
  occurred_at: '2026-07-15T00:00:00.000Z',
  tenant: { id: '20000000-0000-4000-8000-000000000053' },
} as const;

describe('Generation event validation', () => {
  it('normalizes an exact package generation event', () => {
    expect(validateGenerationEvent(EVENT)).toMatchObject({
      data: {
        packageId: EVENT.data.package_id,
        variantRuns: [
          {
            platformCode: 'zhihu',
            runId: EVENT.data.variant_runs[0].run_id,
            variantId: EVENT.data.variant_runs[0].variant_id,
          },
        ],
      },
      eventId: EVENT.event_id,
      tenantId: EVENT.tenant.id,
    });
  });

  it('rejects model-visible tenant scope and unknown data fields', () => {
    expect(() =>
      validateGenerationEvent({
        ...EVENT,
        data: { ...EVENT.data, tenant_id: EVENT.tenant.id },
      }),
    ).toThrow(GenerationWorkerError);
    expect(() =>
      validateGenerationEvent({
        ...EVENT,
        data: {
          ...EVENT.data,
          writer_input: { context: { tenant_id: EVENT.tenant.id } },
        },
      }),
    ).toThrow(GenerationWorkerError);
  });

  it('rejects reused run or variant identifiers', () => {
    expect(() =>
      validateGenerationEvent({
        ...EVENT,
        data: {
          ...EVENT.data,
          variant_runs: [
            EVENT.data.variant_runs[0],
            { ...EVENT.data.variant_runs[0], platform_code: 'douyin' },
          ],
        },
      }),
    ).toThrow('Generation event is invalid');
  });
});
