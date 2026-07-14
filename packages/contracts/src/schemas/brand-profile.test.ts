import { describe, expect, it } from 'vitest';

import { BrandProfileSchema } from './brand-profile.js';

const validProfile = {
  audience: ['Enterprise marketing leaders'],
  banned: ['unverifiable superlatives'],
  compliance: ['Cite material claims'],
  cta: 'Request a GEO readiness assessment',
  differentiators: ['Evidence-led workflow'],
  positioning: 'Enterprise GEO content operations platform',
  tone: 'Clear, credible, and practical',
};

describe('BrandProfileSchema', () => {
  it('accepts the frozen brand-profile@1 shape and trims values', () => {
    const parsed = BrandProfileSchema.parse({
      ...validProfile,
      audience: ['  Enterprise marketing leaders  '],
      positioning: '  Enterprise GEO content operations platform  ',
    });

    expect(parsed.audience).toEqual(['Enterprise marketing leaders']);
    expect(parsed.positioning).toBe('Enterprise GEO content operations platform');
  });

  it('rejects unknown fields, incomplete profiles, and case-insensitive duplicates', () => {
    expect(BrandProfileSchema.safeParse({ ...validProfile, unknown: true }).success).toBe(false);
    expect(BrandProfileSchema.safeParse({ positioning: 'Incomplete' }).success).toBe(false);
    expect(
      BrandProfileSchema.safeParse({
        ...validProfile,
        audience: ['Marketing leaders', 'marketing leaders'],
      }).success,
    ).toBe(false);
  });

  it('enforces frozen field limits and allows an explicit null CTA', () => {
    expect(BrandProfileSchema.safeParse({ ...validProfile, cta: null }).success).toBe(true);
    expect(BrandProfileSchema.safeParse({ ...validProfile, tone: 'x'.repeat(241) }).success).toBe(
      false,
    );
    expect(
      BrandProfileSchema.safeParse({ ...validProfile, differentiators: ['x'.repeat(501)] }).success,
    ).toBe(false);
  });
});
