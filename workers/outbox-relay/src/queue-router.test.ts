import { EVENT_TYPES } from '@geo-content-os/contracts';
import { describe, expect, it } from 'vitest';

import { OUTBOX_QUEUE_NAMES, queueNameFor } from './queue-router.js';

describe('queueNameFor', () => {
  it('routes every frozen event type to a bounded-context queue', () => {
    expect(EVENT_TYPES.map(queueNameFor)).toHaveLength(EVENT_TYPES.length);
    expect(new Set(EVENT_TYPES.map(queueNameFor))).toEqual(new Set(OUTBOX_QUEUE_NAMES));
  });
});
