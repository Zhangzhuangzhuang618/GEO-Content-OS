import { describe, expect, it } from 'vitest';

import {
  assertContentVariantTransition,
  canTransitionContentVariant,
  InvalidContentStatusTransitionError,
  resolveGenerationCancellation,
  resolvePublishCancellation,
} from './content-status.js';

describe('Content Variant transitions', () => {
  it('allows the frozen production path and rejects skipped gates', () => {
    const path = [
      'draft',
      'generating',
      'generated',
      'quality_passed',
      'in_review',
      'review_approved',
      'approved',
      'scheduled',
      'publishing',
      'published',
    ] as const;
    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransitionContentVariant({ from: path[index]!, to: path[index + 1]! })).toBe(true);
    }
    expect(canTransitionContentVariant({ from: 'generated', to: 'approved' })).toBe(false);
    expect(() => assertContentVariantTransition({ from: 'generated', to: 'approved' })).toThrow(
      InvalidContentStatusTransitionError,
    );
  });

  it('permits cancelled only for an explicit drop from a safe stable state', () => {
    expect(canTransitionContentVariant({ cause: 'drop', from: 'generated', to: 'cancelled' })).toBe(
      true,
    );
    expect(
      canTransitionContentVariant({ cause: 'normal', from: 'generated', to: 'cancelled' }),
    ).toBe(false);
    expect(
      canTransitionContentVariant({ cause: 'drop', from: 'publishing', to: 'cancelled' }),
    ).toBe(false);
    expect(canTransitionContentVariant({ from: 'cancelled', to: 'draft' })).toBe(false);
  });

  it('restores generation cancellation to draft or the explicit previous stable state', () => {
    expect(resolveGenerationCancellation({ hasCurrentContent: false })).toBe('draft');
    expect(
      resolveGenerationCancellation({
        hasCurrentContent: true,
        previousStableStatus: 'quality_passed',
      }),
    ).toBe('quality_passed');
    expect(
      canTransitionContentVariant({
        cause: 'generation_cancel',
        from: 'generating',
        to: 'quality_passed',
      }),
    ).toBe(true);
    expect(
      canTransitionContentVariant({
        cause: 'generation_cancel',
        from: 'generating',
        to: 'cancelled',
      }),
    ).toBe(false);
  });

  it('distinguishes publish cancellation before and after an external platform call', () => {
    expect(resolvePublishCancellation(false)).toEqual({
      publishJobStatus: 'cancelled',
      variantStatus: 'approved',
    });
    expect(resolvePublishCancellation(true)).toEqual({
      publishJobStatus: 'cancel_requested',
      variantStatus: 'publishing',
    });
    expect(
      canTransitionContentVariant({
        cause: 'publish_cancel_before_call',
        from: 'publishing',
        to: 'approved',
      }),
    ).toBe(true);
  });
});
