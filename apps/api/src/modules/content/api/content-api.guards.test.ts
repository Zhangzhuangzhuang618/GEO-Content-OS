import { describe, expect, it } from 'vitest';

import { canRegenerateContentVariant } from './content-api.guards.js';

describe('content API guards', () => {
  it('permits retrying a failed generation', () => {
    expect(canRegenerateContentVariant('generation_failed')).toBe(true);
  });

  it('rejects statuses outside the frozen regeneration transition', () => {
    expect(canRegenerateContentVariant('draft')).toBe(false);
    expect(canRegenerateContentVariant('generating')).toBe(false);
    expect(canRegenerateContentVariant('published')).toBe(false);
  });
});
