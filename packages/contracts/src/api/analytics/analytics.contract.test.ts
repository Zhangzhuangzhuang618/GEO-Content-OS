import { describe, expect, it } from 'vitest';

import {
  ANALYTICS_API_CONTRACTS,
  ANALYTICS_OPENAPI_DOCUMENT,
  AnalyticsExportJobResponseSchema,
  AiVisibilityQuerySetCreateSchema,
  AiVisibilityRunCreateSchema,
  CostBudgetQuerySchema,
  CostReconciliationRequestSchema,
  VisibilityImportRequestSchema,
  VisibilityTrendQuerySchema,
} from './index.js';

describe('analytics API contract', () => {
  it('freezes all twenty executable analytics, import, visibility and cost endpoints', () => {
    expect(ANALYTICS_API_CONTRACTS.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /analytics/overview',
      'GET /analytics/platforms',
      'GET /analytics/contents',
      'GET /analytics/costs',
      'GET /analytics/costs/budget',
      'POST /analytics/costs/reconcile',
      'POST /metrics/import',
      'GET /metrics/import-jobs/{id}',
      'POST /metrics/import-jobs/{id}/rollback',
      'POST /metrics/manual',
      'POST /visibility-observations',
      'POST /visibility-observations/import',
      'GET /visibility-observations/trend',
      'POST /ai-visibility/query-sets',
      'GET /ai-visibility/query-sets',
      'POST /ai-visibility/runs',
      'GET /ai-visibility/runs',
      'GET /ai-visibility/runs/{id}',
      'GET /usage/summary',
      'GET /analytics/export',
    ]);
    expect(ANALYTICS_OPENAPI_DOCUMENT.openapi).toBe('3.1.0');
    const operations = Object.values(ANALYTICS_OPENAPI_DOCUMENT.paths).flatMap((path) =>
      Object.values(path),
    );
    expect(operations).toHaveLength(20);
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

  it('validates cost budget and provider statement reconciliation inputs', () => {
    expect(
      CostBudgetQuerySchema.safeParse({
        month: '2026-07',
        workspace_id: '20000000-0000-4000-8000-000000000097',
      }).success,
    ).toBe(true);
    expect(
      CostReconciliationRequestSchema.safeParse({
        from: '2026-07-01',
        statement_lines: [{ billed_cost_cents: 150, currency: 'CNY', provider: 'deepseek' }],
        to: '2026-08-01',
      }).success,
    ).toBe(true);
    expect(
      CostReconciliationRequestSchema.safeParse({
        from: '2026-08-01',
        statement_lines: [{ billed_cost_cents: 150, currency: 'CNY', provider: 'deepseek' }],
        to: '2026-07-01',
      }).success,
    ).toBe(false);
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

  it('validates versioned AI visibility query sets and run requests', () => {
    expect(
      AiVisibilityQuerySetCreateSchema.safeParse({
        brand_name: '志远搬家',
        competitor_names: ['竞品甲', '竞品乙'],
        industry: '搬家服务',
        name: '广州搬家基准问题集',
        project_id: '23000000-0000-4000-8000-000000000001',
        workspace_id: '22000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(true);
    expect(
      AiVisibilityRunCreateSchema.safeParse({
        query_set_id: '24000000-0000-4000-8000-000000000001',
        workspace_id: '22000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(true);
  });
});
