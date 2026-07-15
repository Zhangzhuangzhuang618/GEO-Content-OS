import { describe, expect, it } from 'vitest';

import { publisherBackoffDelay } from './queue.consumer.js';

describe('publisherBackoffDelay', () => {
  it('uses the frozen 1, 5 and 30 minute retry schedule', () => {
    expect([1, 2, 3, 4].map(publisherBackoffDelay)).toEqual([60_000, 300_000, 1_800_000, -1]);
  });
});
