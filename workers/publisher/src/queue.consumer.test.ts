import { describe, expect, it } from 'vitest';

import { publisherBackoffDelay, shouldRecoverPublisherJob } from './queue.consumer.js';

describe('publisherBackoffDelay', () => {
  it('uses the frozen 1, 5 and 30 minute retry schedule', () => {
    expect([1, 2, 3, 4].map(publisherBackoffDelay)).toEqual([60_000, 300_000, 1_800_000, -1]);
  });
});

describe('shouldRecoverPublisherJob', () => {
  const executionJob = {
    attemptsMade: 4,
    name: 'publishing.job.execution_requested.v1',
    opts: { attempts: 4 },
  } as const;

  it('recovers exhausted execution jobs and terminal stalled jobs', () => {
    expect(shouldRecoverPublisherJob(executionJob, new Error('delivery retry exhausted'))).toBe(
      true,
    );
    expect(
      shouldRecoverPublisherJob(
        { ...executionJob, attemptsMade: 0 },
        new Error('job stalled more than allowable limit'),
      ),
    ).toBe(true);
  });

  it('does not duplicate intermediate retries or reconciliation jobs', () => {
    expect(
      shouldRecoverPublisherJob(
        { ...executionJob, attemptsMade: 2 },
        new Error('temporary failure'),
      ),
    ).toBe(false);
    expect(
      shouldRecoverPublisherJob(
        { ...executionJob, name: 'sohu.publication.reconcile_requested.v1' },
        new Error('job stalled more than allowable limit'),
      ),
    ).toBe(false);
  });
});
