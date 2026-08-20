import { describe, expect, it } from 'vitest';

import { findLiejuProhibitedPromotionalTerms } from './lieju-content-policy.js';

describe('Lieju content policy', () => {
  it('finds every publish-blocked promotional term, including quoted negative examples', () => {
    expect(
      findLiejuProhibitedPromotionalTerms(
        '不要轻信“百分百满意”或“行业第一”等承诺，也不要写自称第一。',
      ),
    ).toEqual(['百分百', '行业第一', '自称第一']);
  });

  it('does not treat ordinary sequence or first-party evidence wording as a ranking claim', () => {
    expect(
      findLiejuProhibitedPromotionalTerms(
        '第一步核对清单，第一阶段确认报价，企业第一方资料需要单独标注。',
      ),
    ).toEqual([]);
  });
});
