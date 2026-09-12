import { describe, it, expect } from 'vitest';
import { recommendationHistoryExcerpt } from './recommendation-history.js';

describe('recommendation history excerpts', () => {
  it('includes only bounded company prose and title, not contacts or unrelated material', () => {
    expect(
      recommendationHistoryExcerpt({
        title: '旧文章',
        blocks: [
          { block_key: 'company_1', text: 'a'.repeat(900) },
          { block_key: 'company_1_contact', text: '123456' },
          { block_key: 'opening', text: '开头' },
        ],
      }),
    ).toEqual({ title: '旧文章', company_sections: ['a'.repeat(700)] });
  });
  it('handles older content without company sections', () => {
    expect(recommendationHistoryExcerpt({ title: '旧稿' })).toEqual({
      title: '旧稿',
      company_sections: [],
    });
  });
});
