import { describe, expect, it } from 'vitest';

import { GenerationWorkerError } from './generation.errors.js';
import { validateQualityEvent } from './quality.event.js';

const VARIANT_ID = '70000000-0000-4000-8000-000000000054';
const EVENT = {
  aggregate: { id: VARIANT_ID, type: 'content_variant' },
  data: {
    actor_user_id: '10000000-0000-4000-8000-000000000054',
    content_hash: 'a'.repeat(64),
    content_version_id: '80000000-0000-4000-8000-000000000054',
    generation_run_id: '90000000-0000-4000-8000-000000000054',
    package_id: '60000000-0000-4000-8000-000000000054',
    project_id: '40000000-0000-4000-8000-000000000054',
    request_id: 'quality-request-54',
    variant_id: VARIANT_ID,
    workspace_id: '30000000-0000-4000-8000-000000000054',
  },
  event_id: 'a0000000-0000-4000-8000-000000000054',
  event_type: 'content.variant.quality_check_requested.v1',
  occurred_at: '2026-07-18T00:00:00.000Z',
  tenant: { id: '20000000-0000-4000-8000-000000000054' },
} as const;

describe('Quality event validation', () => {
  it('normalizes an exact quality-check event', () => {
    expect(validateQualityEvent(EVENT)).toMatchObject({
      data: {
        contentHash: EVENT.data.content_hash,
        generationRunId: EVENT.data.generation_run_id,
        sourcePublishJobId: null,
        validationMode: 'full',
        variantId: VARIANT_ID,
      },
      eventId: EVENT.event_id,
      tenantId: EVENT.tenant.id,
    });
  });

  it('accepts manual-edit validation only with its cancelled source job identifier', () => {
    const sourcePublishJobId = 'b0000000-0000-4000-8000-000000000054';
    expect(
      validateQualityEvent({
        ...EVENT,
        data: {
          ...EVENT.data,
          source_publish_job_id: sourcePublishJobId,
          validation_mode: 'manual_edit',
        },
      }),
    ).toMatchObject({
      data: { sourcePublishJobId, validationMode: 'manual_edit' },
    });
    expect(() =>
      validateQualityEvent({
        ...EVENT,
        data: { ...EVENT.data, validation_mode: 'manual_edit' },
      }),
    ).toThrow('Quality event is invalid');
    expect(() =>
      validateQualityEvent({
        ...EVENT,
        data: {
          ...EVENT.data,
          source_publish_job_id: sourcePublishJobId,
          validation_mode: 'full',
        },
      }),
    ).toThrow('Quality event is invalid');
  });

  it('rejects unknown fields and mismatched aggregate identifiers', () => {
    expect(() =>
      validateQualityEvent({
        ...EVENT,
        data: { ...EVENT.data, tenant_id: EVENT.tenant.id },
      }),
    ).toThrow(GenerationWorkerError);
    expect(() =>
      validateQualityEvent({
        ...EVENT,
        aggregate: { ...EVENT.aggregate, id: '71000000-0000-4000-8000-000000000054' },
      }),
    ).toThrow('Quality event is invalid');
  });

  it('rejects malformed content hashes and request identifiers', () => {
    expect(() =>
      validateQualityEvent({ ...EVENT, data: { ...EVENT.data, content_hash: 'not-a-hash' } }),
    ).toThrow('Quality event is invalid');
    expect(() =>
      validateQualityEvent({ ...EVENT, data: { ...EVENT.data, request_id: 'contains space' } }),
    ).toThrow('Quality event is invalid');
  });
});
