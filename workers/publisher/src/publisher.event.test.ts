import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { validatePublishEvent } from './publisher.event.js';

describe('validatePublishEvent', () => {
  it('accepts the frozen execution event and rejects extra data', () => {
    const jobId = randomUUID();
    const event = {
      aggregate: { id: jobId, type: 'publish_job' },
      data: {
        job_id: jobId,
        job_version: 1,
        request_id: 'req-t125',
        scheduled_at: new Date().toISOString(),
      },
      event_id: randomUUID(),
      event_type: 'publishing.job.execution_requested.v1',
      occurred_at: new Date().toISOString(),
      tenant: { id: randomUUID() },
    };
    expect(validatePublishEvent(event).jobId).toBe(jobId);
    expect(() =>
      validatePublishEvent({ ...event, data: { ...event.data, credential: 'secret' } }),
    ).toThrow('Publish event is invalid');
  });
});
