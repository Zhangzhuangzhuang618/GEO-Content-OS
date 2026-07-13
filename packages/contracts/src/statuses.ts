export const CONTENT_PACKAGE_STATUSES = Object.freeze([
  'draft',
  'generating',
  'generated',
  'all_failed',
  'editing',
  'in_review',
  'rejected',
  'approved',
  'scheduled',
  'publishing',
  'publish_failed',
  'published',
  'cancelled',
  'archived',
] as const);

export type ContentPackageStatus = (typeof CONTENT_PACKAGE_STATUSES)[number];

export const CONTENT_VARIANT_STATUSES = Object.freeze([
  'draft',
  'generating',
  'generation_failed',
  'generated',
  'quality_failed',
  'quality_passed',
  'in_review',
  'review_approved',
  'review_rejected',
  'approved',
  'scheduled',
  'publishing',
  'published',
  'publish_failed',
  'cancelled',
] as const);

export type ContentVariantStatus = (typeof CONTENT_VARIANT_STATUSES)[number];

export const OUTBOX_STATUSES = Object.freeze([
  'pending',
  'processing',
  'published',
  'failed',
] as const);
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];
