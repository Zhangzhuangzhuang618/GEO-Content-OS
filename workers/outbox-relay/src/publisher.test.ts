import { describe, expect, it } from 'vitest';

import { queuePriorityForEvent, retryOptionsForEvent } from './publisher.js';

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

  it('finishes quality and rewrite work before starting more daily generation', () => {
    expect(queuePriorityForEvent('content.variant.quality_check_requested.v1')).toEqual({
      priority: 1,
    });
    expect(queuePriorityForEvent('content.variant.official_site_rewrite_requested.v1')).toEqual({
      priority: 2,
    });
    expect(queuePriorityForEvent('content.package.generation_requested.v1')).toEqual({
      priority: 3,
    });
  });

  it('does not prioritize unrelated events', () => {
    expect(queuePriorityForEvent('strategy.topic_plan.generation_requested.v1')).toEqual({});
  });
});
