import { describe, expect, it } from 'vitest';

import { assessUnknownPublishResolution } from './publish-job-unknown-resolution.js';

const BASE = {
  contentVersionId: '50000000-0000-4000-8000-000000000130',
  jobStatus: 'failed' as const,
  latestAttempt: { errorCode: 'PUBLISH_STATE_UNKNOWN', status: 'unknown' as const },
  liejuOfficial: true,
  platformCode: 'lieju' as const,
  variantCurrentContentVersionId: '50000000-0000-4000-8000-000000000130',
  variantStatus: 'publish_failed' as const,
};

describe('assessUnknownPublishResolution', () => {
  it('allows manual resolution while the failed job still owns the current content state', () => {
    expect(assessUnknownPublishResolution(BASE)).toEqual({
      blockedReason: null,
      processingOfficial: false,
    });
  });

  it('blocks stale actions after the content enters another processing state', () => {
    expect(assessUnknownPublishResolution({ ...BASE, variantStatus: 'quality_passed' })).toEqual({
      blockedReason: 'content_state_changed',
      processingOfficial: false,
    });
  });

  it('blocks stale actions after a new content version becomes current', () => {
    expect(
      assessUnknownPublishResolution({
        ...BASE,
        variantCurrentContentVersionId: '51000000-0000-4000-8000-000000000130',
      }),
    ).toEqual({
      blockedReason: 'content_version_changed',
      processingOfficial: false,
    });
  });

  it('keeps Lieju official processing available for manual reconciliation', () => {
    expect(
      assessUnknownPublishResolution({
        ...BASE,
        jobStatus: 'publishing',
        latestAttempt: { errorCode: null, status: 'succeeded' },
        variantStatus: 'publishing',
      }),
    ).toEqual({ blockedReason: null, processingOfficial: true });
  });

  it('allows recovery after Douyin reconciliation fails a previously accepted submission', () => {
    expect(
      assessUnknownPublishResolution({
        ...BASE,
        latestAttempt: { errorCode: null, status: 'succeeded' },
        liejuOfficial: false,
        platformCode: 'douyin',
      }),
    ).toEqual({ blockedReason: null, processingOfficial: false });
  });
});
