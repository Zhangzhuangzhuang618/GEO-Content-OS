import { describe, expect, it } from 'vitest';

import {
  CommitKeywordImportRequestSchema,
  CreateKeywordSetRequestSchema,
  KeywordImportJobResponseSchema,
  KeywordInputSchema,
  KeywordListQuerySchema,
  KeywordSetDetailResponseSchema,
  KeywordSetPageSchema,
  KeywordSetQuerySchema,
  ProjectKeywordPlatformScopeSyncResponseSchema,
  SyncProjectKeywordPlatformScopeRequestSchema,
  UpsertKeywordsRequestSchema,
} from './keywords.js';

const validKeyword = {
  intents: ['informational'] as const,
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
        intents: ['commercial', 'transactional'],
        platform_scope: ['zhihu'],
        term: '  GEO platform  ',
      }),
    ).toMatchObject({
      intents: ['commercial', 'transactional'],
      priority: 50,
      status: 'active',
      synonyms: [],
      term: 'GEO platform',
    });
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
        intents: ['commercial', 'commercial'],
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
    expect(KeywordInputSchema.safeParse({ ...validKeyword, intents: ['awareness'] }).success).toBe(
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

  it('validates paginated keyword queries and safe import selections', () => {
    expect(KeywordListQuerySchema.parse({ limit: '20', status: 'disabled' })).toEqual({
      limit: 20,
      status: 'disabled',
    });
    expect(
      CommitKeywordImportRequestSchema.parse({
        platform_scope: ['official_site'],
        selected_page_types: ['服务页', '报价页'],
        selected_source_intents: ['本地搜索', '价格咨询'],
      }),
    ).toMatchObject({ priority: 50, status: 'disabled' });
    expect(
      CommitKeywordImportRequestSchema.safeParse({
        platform_scope: ['official_site'],
        selected_page_types: ['服务页', '服务页'],
        selected_source_intents: ['本地搜索'],
      }).success,
    ).toBe(false);
  });

  it('validates project platform-scope synchronization without changing keyword state', () => {
    expect(
      SyncProjectKeywordPlatformScopeRequestSchema.parse({
        platform_codes: ['sohu', 'lieju'],
        project_id: '21000000-0000-4000-8000-000000000001',
      }),
    ).toEqual({
      platform_codes: ['sohu', 'lieju'],
      project_id: '21000000-0000-4000-8000-000000000001',
    });
    expect(
      ProjectKeywordPlatformScopeSyncResponseSchema.safeParse({
        data: {
          active_keyword_count: 12,
          changed_count: 10,
          matched_count: 15,
          platform_codes: ['sohu', 'lieju'],
          project_id: '21000000-0000-4000-8000-000000000001',
        },
        meta: { request_id: 'request-platform-scope-sync' },
      }).success,
    ).toBe(true);
    expect(
      SyncProjectKeywordPlatformScopeRequestSchema.safeParse({
        platform_codes: ['lieju', 'lieju'],
        project_id: '21000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(false);
  });

  it('validates keyword import job progress responses', () => {
    expect(
      KeywordImportJobResponseSchema.safeParse({
        data: {
          candidate_count: 2,
          content_hash: 'a'.repeat(64),
          created_at: '2026-08-03T00:00:00.000Z',
          error: null,
          file_name: '广州搬家关键词库.xlsx',
          folded_row_count: 1,
          id: '10000000-0000-4000-8000-000000000001',
          imported_count: 0,
          invalid_row_count: 0,
          keyword_set_id: '20000000-0000-4000-8000-000000000001',
          selected_count: 0,
          sheet_name: '关键词库',
          status: 'preflight_ready',
          summary: {
            candidate_samples: [
              {
                intents: ['commercial', 'transactional'],
                source_intent: '本地搜索',
                suggested_page_type: '服务页',
                synonyms: ['广州荔湾搬家附近'],
                term: '广州荔湾附近搬家',
              },
            ],
            page_types: [{ count: 2, label: '服务页' }],
            source_intents: [{ count: 2, label: '本地搜索' }],
          },
          tenant_id: '30000000-0000-4000-8000-000000000001',
          total_row_count: 3,
          updated_at: '2026-08-03T00:00:00.000Z',
        },
        meta: { request_id: 'request-keyword-import-1' },
      }).success,
    ).toBe(true);
  });
});
