import type { ContentPackageStatus, ContentVariantStatus } from '@geo-content-os/contracts';

export interface PackageVariantProjection {
  readonly isRequired: boolean;
  readonly status: ContentVariantStatus;
}

export interface PackageStatusProjectionInput {
  readonly currentStatus: ContentPackageStatus;
  readonly hasActiveReview?: boolean;
  readonly hasManualEdits?: boolean;
  readonly variants: readonly PackageVariantProjection[];
}

const EDITABLE_CONTENT_STATUSES = new Set<ContentVariantStatus>([
  'generated',
  'quality_failed',
  'quality_passed',
  'review_approved',
  'published',
]);

/** Derives the Package summary only; authorization must continue to read Variant state. */
export class PackageStatusProjector {
  public project(input: PackageStatusProjectionInput): ContentPackageStatus {
    if (input.currentStatus === 'archived' || input.currentStatus === 'cancelled') {
      return input.currentStatus;
    }

    const required = input.variants.filter((variant) => variant.isRequired);
    if (required.some((variant) => variant.status === 'publishing')) return 'publishing';
    if (
      input.hasActiveReview === true ||
      required.some((variant) => variant.status === 'in_review')
    ) {
      return 'in_review';
    }
    if (required.some((variant) => variant.status === 'generating')) return 'generating';
    if (required.some((variant) => variant.status === 'publish_failed')) return 'publish_failed';
    if (required.some((variant) => variant.status === 'scheduled')) return 'scheduled';
    if (required.length > 0 && required.every((variant) => variant.status === 'published')) {
      return 'published';
    }
    if (required.some((variant) => variant.status === 'review_rejected')) return 'rejected';
    if (required.some((variant) => variant.status === 'approved')) return 'approved';
    if (input.hasManualEdits === true) return 'editing';
    if (required.some((variant) => EDITABLE_CONTENT_STATUSES.has(variant.status))) {
      return 'generated';
    }
    if (
      required.length > 0 &&
      required.every((variant) => variant.status === 'generation_failed')
    ) {
      return 'all_failed';
    }
    return 'draft';
  }
}
