import type { ContentVariantStatus } from '../statuses.js';

export type ContentVariantTransitionCause =
  | 'drop'
  | 'generation_cancel'
  | 'normal'
  | 'official_site_automation'
  | 'publish_cancel_before_call';

export type GenerationStableStatus = Exclude<
  ContentVariantStatus,
  'cancelled' | 'draft' | 'generating' | 'in_review' | 'publishing' | 'scheduled'
>;

export interface ContentVariantTransition {
  readonly cause?: ContentVariantTransitionCause;
  readonly from: ContentVariantStatus;
  readonly to: ContentVariantStatus;
}

export class InvalidContentStatusTransitionError extends Error {
  public constructor(from: ContentVariantStatus, to: ContentVariantStatus) {
    super(`Content Variant cannot transition from ${from} to ${to}`);
    this.name = 'InvalidContentStatusTransitionError';
  }
}

const NORMAL_TRANSITIONS = Object.freeze({
  approved: Object.freeze(['quality_failed', 'scheduled']),
  cancelled: Object.freeze([]),
  draft: Object.freeze(['generating']),
  generated: Object.freeze(['generating', 'quality_failed', 'quality_passed']),
  generating: Object.freeze(['generated', 'generation_failed']),
  generation_failed: Object.freeze(['generating']),
  in_review: Object.freeze(['review_approved', 'review_rejected']),
  published: Object.freeze(['quality_failed']),
  publishing: Object.freeze(['publish_failed', 'published']),
  publish_failed: Object.freeze(['approved', 'publishing']),
  quality_failed: Object.freeze(['generated', 'generating', 'quality_passed']),
  quality_passed: Object.freeze(['in_review', 'quality_failed']),
  review_approved: Object.freeze(['approved', 'review_rejected']),
  review_rejected: Object.freeze(['generated', 'in_review', 'quality_failed']),
  scheduled: Object.freeze(['approved', 'publishing']),
} as const satisfies Record<ContentVariantStatus, readonly ContentVariantStatus[]>);

const DROPPABLE_STATUSES = new Set<ContentVariantStatus>([
  'draft',
  'generation_failed',
  'generated',
  'quality_failed',
  'quality_passed',
  'review_rejected',
  'approved',
  'publish_failed',
]);

const GENERATION_STABLE_STATUSES = new Set<GenerationStableStatus>([
  'approved',
  'generated',
  'generation_failed',
  'published',
  'publish_failed',
  'quality_failed',
  'quality_passed',
  'review_approved',
  'review_rejected',
]);

export function canTransitionContentVariant(input: ContentVariantTransition): boolean {
  if (input.from === input.to) return false;
  const cause = input.cause ?? 'normal';
  if (cause === 'drop') {
    return input.to === 'cancelled' && DROPPABLE_STATUSES.has(input.from);
  }
  if (cause === 'generation_cancel') {
    return (
      input.from === 'generating' &&
      (input.to === 'draft' || GENERATION_STABLE_STATUSES.has(input.to as GenerationStableStatus))
    );
  }
  if (cause === 'publish_cancel_before_call') {
    return input.from === 'publishing' && input.to === 'approved';
  }
  if (cause === 'official_site_automation') {
    return (
      (input.from === 'quality_passed' && input.to === 'scheduled') ||
      (input.from === 'publish_failed' && input.to === 'quality_passed') ||
      ((input.from === 'scheduled' || input.from === 'publishing') && input.to === 'quality_passed')
    );
  }
  const allowed = NORMAL_TRANSITIONS[input.from] as readonly ContentVariantStatus[];
  return allowed.includes(input.to);
}

export function assertContentVariantTransition(input: ContentVariantTransition): void {
  if (!canTransitionContentVariant(input)) {
    throw new InvalidContentStatusTransitionError(input.from, input.to);
  }
}

export function resolveGenerationCancellation(
  input:
    | { readonly hasCurrentContent: false }
    | { readonly hasCurrentContent: true; readonly previousStableStatus: GenerationStableStatus },
): ContentVariantStatus {
  if (!input.hasCurrentContent) return 'draft';
  if (!GENERATION_STABLE_STATUSES.has(input.previousStableStatus)) {
    throw new InvalidContentStatusTransitionError('generating', input.previousStableStatus);
  }
  return input.previousStableStatus;
}

export interface PublishCancellationResolution {
  readonly publishJobStatus: 'cancel_requested' | 'cancelled';
  readonly variantStatus: 'approved' | 'publishing';
}

export function resolvePublishCancellation(
  platformCallStarted: boolean,
): PublishCancellationResolution {
  return platformCallStarted
    ? { publishJobStatus: 'cancel_requested', variantStatus: 'publishing' }
    : { publishJobStatus: 'cancelled', variantStatus: 'approved' };
}
