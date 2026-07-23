import { describe, expect, it } from 'vitest';

import { toReviewApiIsoTimestamp } from './review-api.service.js';

describe('review API timestamp serialization', () => {
  it.each([new Date('2026-07-18T08:02:42.000Z'), '2026-07-18 08:02:42+00'])(
    'serializes PostgreSQL timestamp value %s',
    (value) => {
      expect(toReviewApiIsoTimestamp(value)).toBe('2026-07-18T08:02:42.000Z');
    },
  );
});
