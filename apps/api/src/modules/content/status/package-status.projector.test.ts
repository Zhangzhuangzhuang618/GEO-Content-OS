import type { ContentPackageStatus, ContentVariantStatus } from '@geo-content-os/contracts';
import { describe, expect, it } from 'vitest';

import {
  PackageStatusProjector,
  type PackageVariantProjection,
} from './package-status.projector.js';

const projector = new PackageStatusProjector();

describe('PackageStatusProjector', () => {
  it('implements the frozen non-terminal priority order', () => {
    const cases: readonly [ContentPackageStatus, readonly ContentVariantStatus[]][] = [
      ['publishing', ['publishing', 'in_review', 'generating', 'publish_failed']],
      ['in_review', ['in_review', 'generating', 'publish_failed', 'scheduled']],
      ['generating', ['generating', 'publish_failed', 'scheduled', 'approved']],
      ['publish_failed', ['publish_failed', 'scheduled', 'approved']],
      ['scheduled', ['scheduled', 'approved', 'generated']],
      ['rejected', ['review_rejected', 'approved', 'generated']],
      ['approved', ['approved', 'generated']],
      ['generated', ['quality_passed', 'generated']],
      ['all_failed', ['generation_failed', 'generation_failed']],
      ['draft', ['draft', 'generation_failed']],
    ];
    for (const [expected, statuses] of cases) {
      expect(projector.project(input(statuses))).toBe(expected);
    }
  });

  it('reports published only when every required Variant is published', () => {
    expect(projector.project(input(['published', 'published']))).toBe('published');
    expect(projector.project(input(['published', 'approved']))).toBe('approved');
    expect(projector.project(input(['published', 'publish_failed']))).toBe('publish_failed');
  });

  it('supports partial generation without letting failures hide successful content', () => {
    expect(projector.project(input(['generated', 'generation_failed']))).toBe('generated');
    expect(projector.project(input(['quality_failed', 'generation_failed']))).toBe('generated');
    expect(projector.project(input(['generation_failed', 'generation_failed']))).toBe('all_failed');
  });

  it('ignores optional dropped Variants and keeps explicit terminal Package states', () => {
    const variants: PackageVariantProjection[] = [
      { isRequired: true, status: 'approved' },
      { isRequired: false, status: 'cancelled' },
      { isRequired: false, status: 'publishing' },
    ];
    expect(projector.project({ currentStatus: 'draft', variants })).toBe('approved');
    expect(projector.project({ currentStatus: 'cancelled', variants })).toBe('cancelled');
    expect(projector.project({ currentStatus: 'archived', variants })).toBe('archived');
  });

  it('uses active review and manual edit facts without treating Package state as authority', () => {
    expect(projector.project({ ...input(['quality_passed']), hasActiveReview: true })).toBe(
      'in_review',
    );
    expect(projector.project({ ...input(['generated']), hasManualEdits: true })).toBe('editing');
    expect(
      projector.project({
        ...input(['approved', 'generated']),
        hasManualEdits: true,
      }),
    ).toBe('approved');
  });
});

function input(statuses: readonly ContentVariantStatus[]) {
  return {
    currentStatus: 'draft' as const,
    variants: statuses.map((status) => ({ isRequired: true, status })),
  };
}
