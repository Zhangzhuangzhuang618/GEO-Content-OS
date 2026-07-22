import { expect, test, type Page, type Route } from '@playwright/test';

const TENANT = '10000000-0000-4000-8000-000000000097';
const WORKSPACE = '20000000-0000-4000-8000-000000000097';
const PROJECT = '30000000-0000-4000-8000-000000000097';
const PACKAGE = '40000000-0000-4000-8000-000000000097';
const VARIANT = '50000000-0000-4000-8000-000000000097';
const RUN = '60000000-0000-4000-8000-000000000097';

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    { name: 'geo_csrf', url: 'http://127.0.0.1:34127', value: 'c'.repeat(43) },
  ]);
  await role(page, 'analyst');
  await page.route('**/api/v1/workspaces?*', (route) =>
    json(route, { data: [workspace()], meta: { next_cursor: null, request_id: 'workspace' } }),
  );
  await page.route('**/api/v1/analytics/costs?*', (route) => json(route, costReport()));
  await page.route('**/api/v1/analytics/costs/budget?*', (route) =>
    json(route, {
      data: {
        consumed_cents: 170,
        currency: 'CNY',
        hard_limit: true,
        is_exceeded: true,
        is_exhausted: true,
        limit_cents: 150,
        month: '2026-07',
        remaining_cents: 0,
        workspace_id: WORKSPACE,
      },
      meta: { request_id: 'budget' },
    }),
  );
});

test('shows attributed settled costs and exports the filtered ledger view on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `/anl-04?workspace_id=${WORKSPACE}&from=2026-07-01&to=2026-08-01&month=2026-07&model_key=deepseek-flash&skill_name=content-writer`,
  );
  await expect(page.getByRole('heading', { name: '成本明细' })).toBeVisible();
  await expect(page.getByText('成本企业').last()).toBeVisible();
  await expect(page.getByText(PROJECT)).toBeHidden();
  await expect(page.getByText(PACKAGE)).toBeHidden();
  await expect(page.getByText('DeepSeek · 快速生成')).toBeVisible();
  await expect(page.getByText('撰写内容')).toBeVisible();
  await expect(page.getByText('content-writer')).toHaveCount(0);
  await expect(page.getByText('1.70 CNY', { exact: true })).toBeVisible();
  await expect(page.getByText('1.50 CNY', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('已超限')).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出当前 CSV' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('cost-center-2026-07-01-2026-08-01.csv');
  await expect(page.getByText('已导出 1 行当前成本明细')).toBeVisible();
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

test('reconciles a provider statement with ledger totals without persisting the bill', async ({
  page,
}) => {
  let body: Record<string, unknown> | null = null;
  let csrf = '';
  await page.route('**/api/v1/analytics/costs/reconcile', async (route) => {
    body = route.request().postDataJSON() as Record<string, unknown>;
    csrf = route.request().headers()['x-csrf-token'] ?? '';
    await json(route, {
      data: {
        from: '2026-07-01T00:00:00.000Z',
        items: [
          {
            billed_cost_cents: 150,
            currency: 'CNY',
            delta_cents: 0,
            ledger_cost_cents: 150,
            provider: 'deepseek',
            status: 'matched',
          },
          {
            billed_cost_cents: 25,
            currency: 'CNY',
            delta_cents: -5,
            ledger_cost_cents: 20,
            provider: 'object-storage',
            status: 'mismatch',
          },
        ],
        settled_only: true,
        to: '2026-08-01T00:00:00.000Z',
      },
      meta: { request_id: 'reconcile' },
    });
  });
  await page.goto(`/anl-04?workspace_id=${WORKSPACE}&from=2026-07-01&to=2026-08-01&month=2026-07`);
  await page.getByLabel('供应商账单 CSV').setInputFiles({
    buffer: Buffer.from(
      'provider,currency,billed_cost_cents\ndeepseek,CNY,150\nobject-storage,CNY,25\n',
    ),
    mimeType: 'text/csv',
    name: 'provider-statement.csv',
  });
  await expect(page.getByText('供应商账单校验通过，共 2 行')).toBeVisible();
  await page.getByRole('button', { name: '与 ledger 对账' }).click();
  await expect(page.getByRole('heading', { name: '对账结果' })).toBeVisible();
  await expect(page.getByText('一致', { exact: true })).toBeVisible();
  await expect(page.getByText('金额不一致')).toBeVisible();
  expect(csrf).toBe('c'.repeat(43));
  expect(body).toMatchObject({
    from: '2026-07-01',
    statement_lines: [
      { billed_cost_cents: 150, currency: 'CNY', provider: 'deepseek' },
      { billed_cost_cents: 25, currency: 'CNY', provider: 'object-storage' },
    ],
    to: '2026-08-01',
    workspace_id: WORKSPACE,
  });
});

test('denies a viewer before cost data requests', async ({ page }) => {
  let requests = 0;
  await page.unroute('**/api/v1/auth/tenants');
  await role(page, 'viewer');
  await page.route('**/api/v1/analytics/costs**', async (route) => {
    requests++;
    await route.abort();
  });
  await page.goto(`/anl-04?workspace_id=${WORKSPACE}&from=2026-07-01&to=2026-08-01&month=2026-07`);
  await expect(page.getByRole('heading', { name: '无权访问成本中心' })).toBeVisible();
  expect(requests).toBe(0);
});

function costReport() {
  return {
    data: {
      breakdown: [
        {
          cost_category: 'llm',
          cost_cents: 150,
          currency: 'CNY',
          entry_count: 1,
          generation_run_id: RUN,
          model_key: 'deepseek-flash',
          package_id: PACKAGE,
          project_id: PROJECT,
          provider: 'deepseek',
          skill_name: 'content-writer',
          variant_id: VARIANT,
          workspace_id: WORKSPACE,
        },
        {
          cost_category: 'storage',
          cost_cents: 20,
          currency: 'CNY',
          entry_count: 1,
          generation_run_id: RUN,
          model_key: null,
          package_id: PACKAGE,
          project_id: PROJECT,
          provider: 'object-storage',
          skill_name: null,
          variant_id: VARIANT,
          workspace_id: WORKSPACE,
        },
      ],
      package_totals: [{ cost_cents: 170, currency: 'CNY', entry_count: 2, package_id: PACKAGE }],
      settled_only: true,
      totals: [{ cost_cents: 170, currency: 'CNY', entry_count: 2 }],
    },
    meta: { request_id: 'costs' },
  };
}

function workspace() {
  return {
    created_at: '2026-07-16T00:00:00.000Z',
    id: WORKSPACE,
    name: '成本工作区',
    settings: {
      budget_policy: { hard_limit: true, monthly_limit_cny: 1.5 },
      default_platform_codes: ['official_site'],
      schema_version: 'workspace-settings@1',
    },
    slug: 'cost-center',
    status: 'active',
    tenant_id: TENANT,
    timezone: 'Asia/Shanghai',
    updated_at: '2026-07-16T00:00:00.000Z',
    version: 1,
  };
}

async function role(page: Page, code: string) {
  await page.route('**/api/v1/auth/tenants', (route) =>
    json(route, {
      data: [
        {
          id: TENANT,
          is_active: true,
          last_used_at: null,
          name: '成本企业',
          role_code: code,
          slug: 'cost-tenant',
        },
      ],
      meta: { request_id: 'role' },
    }),
  );
}

async function json(route: Route, body: unknown) {
  await route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status: 200 });
}
