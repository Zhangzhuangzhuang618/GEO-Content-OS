import { describe, expect, it } from 'vitest';

import {
  ANALYTICS_API_CONTRACTS,
  ANALYTICS_OPENAPI_DOCUMENT,
  AnalyticsExportJobResponseSchema,
  VisibilityImportRequestSchema,
  VisibilityTrendQuerySchema,
} from './index.js';

describe('analytics API contract', () => {
  it('freezes all thirteen executable analytics, import, visibility and cost endpoints', () => {
    expect(ANALYTICS_API_CONTRACTS.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /analytics/overview',
      'GET /analytics/platforms',
      'GET /analytics/contents',
      'GET /analytics/costs',
      'POST /metrics/import',
      'GET /metrics/import-jobs/{id}',
      'POST /metrics/import-jobs/{id}/rollback',
      'POST /metrics/manual',
      'POST /visibility-observations',
      'POST /visibility-observations/import',
      'GET /visibility-observations/trend',
      'GET /usage/summary',
      'GET /analytics/export',
    ]);
    expect(ANALYTICS_OPENAPI_DOCUMENT.openapi).toBe('3.1.0');
    const operations = Object.values(ANALYTICS_OPENAPI_DOCUMENT.paths).flatMap((path) =>
      Object.values(path),
    );
    expect(operations).toHaveLength(13);
    for (const contract of ANALYTICS_API_CONTRACTS) {
      const operation = ANALYTICS_OPENAPI_DOCUMENT.paths[contract.path]?.[
        contract.method.toLowerCase()
      ] as Record<string, unknown> | undefined;
      expect(operation).toMatchObject({
        'x-idempotency': contract.idempotency,
        'x-permission': contract.permission,
        'x-policy': contract.policy,
      });
    }
    expect(
      (
        ANALYTICS_OPENAPI_DOCUMENT.paths['/metrics/import']?.['post'] as {
          requestBody?: { content?: Record<string, unknown> };
        }
      ).requestBody?.content,
    ).toHaveProperty('multipart/form-data');
  });

  it('uses the independent analytics export job view', () => {
    expect(
      AnalyticsExportJobResponseSchema.safeParse({
        data: {
          content_hash: null,
          created_at: '2026-07-15T00:00:00.000Z',
          error_json: null,
          expires_at: null,
          id: '3e000000-0000-4000-8000-000000000132',
          object_uri: null,
          query_hash: 'a'.repeat(64),
          requested_by: '1e000000-0000-4000-8000-000000000132',
          row_count: null,
          status: 'queued',
          tenant_id: '2e000000-0000-4000-8000-000000000132',
          updated_at: '2026-07-15T00:00:00.000Z',
          version: 1,
          workspace_id: '4e000000-0000-4000-8000-000000000132',
        },
        meta: { request_id: 'analytics-request-0001' },
      }).success,
    ).toBe(true);
  });

  it('validates visibility import rows and bounded trend filters', () => {
    expect(
      VisibilityImportRequestSchema.safeParse({
        rows: [
          {
            is_cited: true,
            observed_at: '2026-07-16T08:00:00.000Z',
            platform_code: 'zhihu',
            query_text: 'GEO Content OS',
            rank_position: 2,
          },
        ],
        workspace_id: '20000000-0000-4000-8000-000000000096',
      }).success,
    ).toBe(true);
    expect(
      VisibilityTrendQuerySchema.safeParse({
        from: '2026-07-17',
        to: '2026-07-16',
        workspace_id: '20000000-0000-4000-8000-000000000096',
      }).success,
    ).toBe(false);
  });
});
