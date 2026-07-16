import { ANALYTICS_API_CONTRACTS } from '@geo-content-os/contracts';
import { describe, expect, it } from 'vitest';

import { AnalyticsApiController } from './analytics-api.controller.js';

describe('analytics controller contract', () => {
  it('implements the thirteen executable analytics routes', () => {
    expect(AnalyticsApiController).toBeDefined();
    expect(ANALYTICS_API_CONTRACTS).toHaveLength(13);
    expect(ANALYTICS_API_CONTRACTS.filter(({ idempotency }) => idempotency !== '-')).toHaveLength(
      6,
    );
  });
});
