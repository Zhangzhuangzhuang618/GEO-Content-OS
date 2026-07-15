import { describe, expect, it } from 'vitest';

import {
  CreateKeywordSetRequestSchema,
  KeywordInputSchema,
  KeywordSetDetailResponseSchema,
  KeywordSetPageSchema,
  KeywordSetQuerySchema,
  UpsertKeywordsRequestSchema,
} from './keywords.js';

const validKeyword = {
  intent: 'informational' as const,
  platform_scope: ['official_site', 'zhihu'] as const,
  priority: 80,
  status: 'active' as const,
  synonyms: ['generative engine optimization'],
  term: 'GEO content',
};

describe('keyword API contracts', () => {
  it('trims keyword set and keyword values and applies safe defaults', () => {
    expect(
      CreateKeywordSetRequestSchema.parse({
        name: '  Core GEO terms  ',
        project_id: '0b44bf0c-8c9a-44b9-9a19-a1812f5695fb',
      }).name,
    ).toBe('Core GEO terms');

    expect(
      KeywordInputSchema.parse({
        intent: 'commercial',
        platform_scope: ['zhihu'],
        term: '  GEO platform  ',
      }),
    ).toMatchObject({ priority: 50, status: 'active', synonyms: [], term: 'GEO platform' });
  });

  it('rejects duplicate terms, synonyms, and platform codes case-insensitively', () => {
    expect(
      UpsertKeywordsRequestSchema.safeParse({
        keywords: [validKeyword, { ...validKeyword, term: 'geo CONTENT' }],
      }).success,
    ).toBe(false);
    expect(
      KeywordInputSchema.safeParse({
        ...validKeyword,
        synonyms: ['GEO strategy', 'geo strategy'],
      }).success,
    ).toBe(false);
    expect(
      KeywordInputSchema.safeParse({
        ...validKeyword,
        platform_scope: ['zhihu', 'zhihu'],
      }).success,
    ).toBe(false);
  });

  it('enforces frozen intents, platform codes, priority, batch, and strict fields', () => {
    expect(KeywordInputSchema.safeParse({ ...validKeyword, priority: 101 }).success).toBe(false);
    expect(KeywordInputSchema.safeParse({ ...validKeyword, intent: 'awareness' }).success).toBe(
      false,
    );
    expect(
      KeywordInputSchema.safeParse({ ...validKeyword, platform_scope: ['unknown'] }).success,
    ).toBe(false);
    expect(KeywordInputSchema.safeParse({ ...validKeyword, unknown: true }).success).toBe(false);
    expect(UpsertKeywordsRequestSchema.safeParse({ keywords: [] }).success).toBe(false);
  });

  it('validates keyword set list filters and detail responses', () => {
    const query = KeywordSetQuerySchema.parse({ limit: '50', status: 'active' });
    expect(query).toEqual({ limit: 50, status: 'active' });
    expect(KeywordSetQuerySchema.safeParse({ limit: 101 }).success).toBe(false);

    const keywordSet = {
      created_at: '2026-07-15T00:00:00.000Z',
      id: '11000000-0000-4000-8000-000000000001',
      name: 'Core GEO terms',
      project_id: '21000000-0000-4000-8000-000000000001',
      status: 'active' as const,
      tenant_id: '31000000-0000-4000-8000-000000000001',
      updated_at: '2026-07-15T00:00:00.000Z',
    };
    const requestMeta = { request_id: '01J00000000000000000000000' };
    expect(
      KeywordSetPageSchema.safeParse({
        data: [keywordSet],
        meta: { ...requestMeta, next_cursor: null },
      }).success,
    ).toBe(true);
    expect(
      KeywordSetDetailResponseSchema.safeParse({
        data: { ...keywordSet, keywords: [] },
        meta: requestMeta,
      }).success,
    ).toBe(true);
  });
});
