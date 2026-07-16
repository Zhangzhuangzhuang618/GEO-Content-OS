import { expect, test, type Page, type Route } from '@playwright/test';
const TENANT = '10000000-0000-4000-8000-000000000094';
const WORKSPACE = '20000000-0000-4000-8000-000000000094';
const USER = '30000000-0000-4000-8000-000000000094';
test.beforeEach(async ({ page }) => {
  await role(page, 'analyst');
  await page.route('**/api/v1/workspaces?*', (r) =>
    json(r, { data: [workspace()], meta: { next_cursor: null, request_id: 'w' } }),
  );
  await page.route('**/api/v1/analytics/overview?*', (r) =>
    json(r, {
      data: {
        data_updated_at: '2026-07-16T01:30:00.000Z',
        methodology_version: 'geo-analytics@1',
        metrics: metrics(),
        visibility: {
          average_rank: 3.5,
          citation_count: 8,
          citation_rate: 0.4,
          observation_count: 20,
        },
      },
      meta: { request_id: 'o' },
    }),
  );
  await page.route('**/api/v1/analytics/platforms?*', (r) =>
    json(r, {
      data: {
        data_updated_at: '2026-07-16T01:30:00.000Z',
        methodology_version: 'geo-analytics@1',
        platforms: [
          {
            data_updated_at: '2026-07-16T01:20:00.000Z',
            metrics: metrics(),
            platform_code: 'official_site',
            visibility: {
              average_rank: 2,
              citation_count: 5,
              citation_rate: 0.5,
              observation_count: 10,
            },
          },
        ],
      },
      meta: { request_id: 'p' },
    }),
  );
  await page.route('**/api/v1/analytics/costs?*', (r) =>
    json(r, {
      data: {
        breakdown: [],
        package_totals: [],
        settled_only: true,
        totals: [{ cost_cents: 1234, currency: 'CNY', entry_count: 4 }],
      },
      meta: { request_id: 'c' },
    }),
  );
});
test('shows required metrics, methodology and data update time on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/anl-01?workspace_id=${WORKSPACE}&from=2026-07-01&to=2026-07-16`);
  for (const text of [
    '曝光',
    '阅读',
    '互动',
    '转化',
    '可见性',
    '成本（已结算）',
    'geo-analytics@1',
    '数据更新时间',
  ])
    await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
  await expect(page.getByText('12.34 CNY')).toBeVisible();
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});
test('drills into a platform and creates an idempotent CSV export', async ({ page }) => {
  let header = '';
  await page.route('**/api/v1/analytics/export?*', async (r) => {
    header = r.request().headers()['idempotency-key'] ?? '';
    await json(r, {
      data: {
        content_hash: null,
        created_at: '2026-07-16T01:40:00.000Z',
        error_json: null,
        expires_at: null,
        id: '40000000-0000-4000-8000-000000000094',
        object_uri: null,
        query_hash: 'f'.repeat(64),
        requested_by: USER,
        row_count: null,
        status: 'queued',
        tenant_id: TENANT,
        updated_at: '2026-07-16T01:40:00.000Z',
        version: 1,
        workspace_id: WORKSPACE,
      },
      meta: { request_id: 'e' },
    });
  });
  await page.goto(`/anl-01?workspace_id=${WORKSPACE}&from=2026-07-01&to=2026-07-16`);
  await page.getByRole('button', { name: '下钻' }).click();
  await expect(page).toHaveURL(/platform_codes=official_site/u);
  await page.getByRole('button', { name: '导出 CSV' }).click();
  await expect(page.getByText('分析导出任务已创建。')).toBeVisible();
  expect(header).toMatch(/^analytics-export-[0-9a-f-]{36}$/u);
});
test('denies a viewer before analytics requests', async ({ page }) => {
  let requests = 0;
  await page.unroute('**/api/v1/auth/tenants');
  await role(page, 'viewer');
  await page.route('**/api/v1/analytics/**', async (r) => {
    requests++;
    await r.abort();
  });
  await page.goto(`/anl-01?workspace_id=${WORKSPACE}&from=2026-07-01&to=2026-07-16`);
  await expect(page.getByRole('heading', { name: '无权查看数据总览' })).toBeVisible();
  expect(requests).toBe(0);
});
function metrics() {
  return [
    { aggregation: 'sum', name: 'exposures', unit: 'count', value: 1000 },
    { aggregation: 'sum', name: 'reads', unit: 'count', value: 500 },
    { aggregation: 'sum', name: 'engagements', unit: 'count', value: 80 },
    { aggregation: 'sum', name: 'conversions', unit: 'count', value: 12 },
  ];
}
function workspace() {
  return {
    created_at: '2026-07-16T00:00:00.000Z',
    id: WORKSPACE,
    name: '分析工作区',
    settings: { default_platform_codes: ['official_site'], schema_version: 'workspace-settings@1' },
    slug: 'analytics',
    status: 'active',
    tenant_id: TENANT,
    timezone: 'Asia/Shanghai',
    updated_at: '2026-07-16T00:00:00.000Z',
    version: 1,
  };
}
async function role(page: Page, roleCode: string) {
  await page.route('**/api/v1/auth/tenants', (r) =>
    json(r, {
      data: [
        {
          id: TENANT,
          is_active: true,
          last_used_at: null,
          name: '分析企业',
          role_code: roleCode,
          slug: 'analytics',
        },
      ],
      meta: { request_id: 'role' },
    }),
  );
}
async function json(route: Route, body: unknown) {
  await route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status: 200 });
}
