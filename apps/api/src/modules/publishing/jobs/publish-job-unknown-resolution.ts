import type { ContentVariantStatus, PlatformCode, PublishJobView } from '@geo-content-os/contracts';

export type UnknownPublishResolutionBlockedReason =
  'content_state_changed' | 'content_version_changed';

interface UnknownPublishAttempt {
  readonly errorCode: string | null;
  readonly status: 'failed' | 'running' | 'succeeded' | 'unknown';
}

interface UnknownPublishResolutionInput {
  readonly contentVersionId: string;
  readonly jobStatus: PublishJobView['status'];
  readonly latestAttempt: UnknownPublishAttempt | undefined;
  readonly liejuOfficial: boolean;
  readonly platformCode: PlatformCode;
  readonly variantCurrentContentVersionId: string | null;
  readonly variantStatus: ContentVariantStatus;
}

export interface UnknownPublishResolutionAssessment {
  readonly blockedReason: UnknownPublishResolutionBlockedReason | null;
  readonly processingOfficial: boolean;
}

export function assessUnknownPublishResolution(
  input: UnknownPublishResolutionInput,
): UnknownPublishResolutionAssessment | null {
  if (!isBrowserPlatform(input.platformCode)) return null;

  const processingOfficial =
    input.platformCode === 'lieju' &&
    input.liejuOfficial &&
    input.jobStatus === 'publishing' &&
    input.variantStatus === 'publishing';
  const requiresResolution =
    input.latestAttempt?.status === 'unknown' ||
    (input.latestAttempt?.status === 'failed' &&
      input.latestAttempt.errorCode === 'MANUAL_REQUIRED') ||
    (processingOfficial && input.latestAttempt?.status === 'succeeded');

  if (!['failed', 'publishing'].includes(input.jobStatus) || !requiresResolution) return null;
  if (
    !processingOfficial &&
    (input.jobStatus !== 'failed' || input.variantStatus !== 'publish_failed')
  ) {
    return { blockedReason: 'content_state_changed', processingOfficial };
  }
  if (input.variantCurrentContentVersionId !== input.contentVersionId) {
    return { blockedReason: 'content_version_changed', processingOfficial };
  }
  return { blockedReason: null, processingOfficial };
}

function isBrowserPlatform(value: PlatformCode): value is 'baijiahao' | 'lieju' | 'sohu' {
  return value === 'baijiahao' || value === 'lieju' || value === 'sohu';
}
