import type { ContentVariantStatus } from '@geo-content-os/contracts';

const REGENERATABLE_VARIANT_STATUSES = new Set<ContentVariantStatus>([
  'generated',
  'generation_failed',
  'quality_failed',
  'quality_passed',
  'review_rejected',
]);

export function canRegenerateContentVariant(status: ContentVariantStatus): boolean {
  return REGENERATABLE_VARIANT_STATUSES.has(status);
}
