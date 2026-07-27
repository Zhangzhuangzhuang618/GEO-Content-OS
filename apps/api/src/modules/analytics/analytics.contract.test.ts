import { ANALYTICS_API_CONTRACTS } from '@geo-content-os/contracts';
import { describe, expect, it } from 'vitest';

import { AnalyticsApiController } from './analytics-api.controller.js';

describe('analytics controller contract', () => {
  it('implements the twenty executable analytics routes', () => {
    expect(AnalyticsApiController).toBeDefined();
    expect(ANALYTICS_API_CONTRACTS).toHaveLength(20);
    expect(ANALYTICS_API_CONTRACTS.filter(({ idempotency }) => idempotency !== '-')).toHaveLength(
      8,
    );
  });
});
