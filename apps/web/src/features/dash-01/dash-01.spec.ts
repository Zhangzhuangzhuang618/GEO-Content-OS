import { expect, test, type Page } from '@playwright/test';

const TENANT_ID = '10000000-0000-4000-8000-000000000073';
const WORKSPACE_ID = '20000000-0000-4000-8000-000000000073';
const PROJECT_ID = '30000000-0000-4000-8000-000000000073';

test.beforeEach(async ({ page }) => {
  await mockRole(page, 'tenant_admin');
  await page.route('**/api/v1/workspaces?*', (route) => json(route, [workspace()]));
  await page.route('**/api/v1/projects?*', (route) => json(route, [project()]));
  await page.route('**/api/v1/content-packages?*', (route) =>
    json(route, [
      contentPackage('in_review', '40000000-0000-4000-8000-000000000073'),
      contentPackage('publish_failed', '50000000-0000-4000-8000-000000000073'),
    ]),
  );
  await page.route('**/api/v1/analytics/costs?*', (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: {
          breakdown: [],
          package_totals: [],
          settled_only: true,
          totals: [{ cost_cents: 12345, currency: 'CNY', entry_count: 2 }],
        },
        meta: { request_id: 'costs' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
});

test('persists time, workspace and project filters in the URL', async ({ page }) => {
  await page.goto(`/dash-01?from=2026-07-01&to=2026-07-31&workspace_id=${WORKSPACE_ID}`);
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
  await page.getByLabel('项目').selectOption(PROJECT_ID);
  await expect(page).toHaveURL(
    new RegExp(
      `from=2026-07-01.*to=2026-07-31.*workspace_id=${WORKSPACE_ID}.*project_id=${PROJECT_ID}$`,
      'u',
    ),
  );
  await expect(page.getByText('2 个内容包')).toBeVisible();
  await expect(page.getByText('¥123.45')).toBeVisible();
});

test('shows only cards and actions allowed by the active role', async ({ page }) => {
  await page.goto(`/dash-01?from=2026-07-01&to=2026-07-31&workspace_id=${WORKSPACE_ID}`);
  await expect(page.getByText('审核待办')).toBeVisible();
  await expect(page.getByText('发布待办')).toBeVisible();
  await expect(page.getByText('已结算成本')).toBeVisible();
  await expect(page.getByRole('link', { name: '进入审核' })).toBeVisible();
  await expect(page.getByRole('link', { name: '进入发布' })).toBeVisible();

  await mockRole(page, 'viewer');
  await page.reload();
  await expect(page.getByText('内容产能')).toBeVisible();
  await expect(page.getByText('失败任务').first()).toBeVisible();
  await expect(page.getByText('审核待办')).toHaveCount(0);
  await expect(page.getByText('发布待办')).toHaveCount(0);
  await expect(page.getByText('已结算成本')).toHaveCount(0);
  await expect(page.getByRole('link', { name: '进入审核' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '进入发布' })).toHaveCount(0);
});

test('renders permission and empty states without leaking dashboard cards', async ({ page }) => {
  await page.route('**/api/v1/auth/tenants', (route) => route.fulfill({ status: 403 }));
  await page.goto('/dash-01');
  await expect(page.getByRole('status')).toContainText('无权查看当前工作台');
  await expect(page.getByText('已结算成本')).toHaveCount(0);

  await mockRole(page, 'viewer');
  await page.route('**/api/v1/workspaces?*', (route) => json(route, []));
  await page.reload();
  await expect(page.getByRole('status')).toContainText('暂无可用工作区');
});

test('remains usable at mobile width with a keyboard focus entry', async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 375 });
  await page.goto(`/dash-01?from=2026-07-01&to=2026-07-31&workspace_id=${WORKSPACE_ID}`);
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused();
  await expect(page.getByLabel('工作台筛选')).toBeVisible();
});

async function mockRole(page: Page, role: string) {
  await page.route('**/api/v1/auth/tenants', (route) =>
    json(route, [
      {
        id: TENANT_ID,
        is_active: true,
        last_used_at: null,
        name: '示例企业',
        role_code: role,
        slug: 'demo',
      },
    ]),
  );
}

function workspace() {
  return {
    created_at: '2026-07-01T00:00:00.000Z',
    id: WORKSPACE_ID,
    name: '主工作区',
    settings: { schema_version: 'workspace-settings@1' },
    slug: 'main',
    status: 'active',
    tenant_id: TENANT_ID,
    timezone: 'Asia/Shanghai',
    updated_at: '2026-07-01T00:00:00.000Z',
    version: 1,
  };
}

function project() {
  return { id: PROJECT_ID, name: 'GEO 项目', status: 'active', workspace_id: WORKSPACE_ID };
}

function contentPackage(status: 'in_review' | 'publish_failed', id: string) {
  return {
    created_at: '2026-07-15T00:00:00.000Z',
    id,
    project_id: PROJECT_ID,
    status,
    updated_at: '2026-07-15T01:00:00.000Z',
    workspace_id: WORKSPACE_ID,
  };
}

async function json(route: Parameters<Parameters<Page['route']>[1]>[0], data: unknown) {
  await route.fulfill({
    body: JSON.stringify({ data, meta: { next_cursor: null, request_id: 'dash' } }),
    contentType: 'application/json',
    status: 200,
  });
}
