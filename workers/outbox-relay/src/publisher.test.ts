import { describe, expect, it } from 'vitest';

import { retryOptionsForEvent } from './publisher.js';

describe('outbox queue retry options', () => {
  it('retries quality checks three times with bounded backoff', () => {
    expect(retryOptionsForEvent('content.variant.quality_check_requested.v1')).toEqual({
      attempts: 3,
      backoff: { delay: 30_000, type: 'exponential' },
    });
  });

  it('does not add retries to unrelated events', () => {
    expect(retryOptionsForEvent('strategy.topic_plan.generation_requested.v1')).toEqual({});
  });
});
