import { expect, test } from '@playwright/test';

const FIRST_ID = '10000000-0000-4000-8000-000000000099';
const SECOND_ID = '10000000-0000-4000-8000-000000000199';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/auth/tenants', async (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [
          {
            id: '20000000-0000-4000-8000-000000000099',
            is_active: true,
            last_used_at: null,
            name: '设置企业',
            role_code: 'tenant_admin',
            slug: 'settings',
          },
        ],
        meta: { request_id: 'role' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route('**/api/v1/workspaces?*', async (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [workspace(FIRST_ID, '主工作区'), workspace(SECOND_ID, '备用工作区')],
        meta: { next_cursor: null, request_id: 'workspaces' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
});

test('saves complete versioned workspace settings and keeps selection in the URL', async ({
  page,
}) => {
  let body: Record<string, unknown> | undefined;
  let headers: Record<string, string> | undefined;
  await page.route(`**/api/v1/workspaces/${SECOND_ID}`, async (route) => {
    body = route.request().postDataJSON() as Record<string, unknown>;
    headers = route.request().headers();
    await route.fulfill({
      body: JSON.stringify({
        data: { ...workspace(SECOND_ID, '国际工作区'), name: '国际工作区', version: 2 },
        meta: { request_id: 'update' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`/set-02?id=${SECOND_ID}`);
  await page.getByLabel('名称').fill('国际工作区');
  await page.getByLabel('时区').fill('Asia/Tokyo');
  await page.getByLabel('知乎').check();
  await page.getByLabel('最低审核人数').selectOption('2');
  await page.getByLabel('月度预算（元，可留空）').fill('50000');
  await page.getByLabel('达到预算后硬阻断').check();
  await page.getByLabel('高风险内容必须加签').check();
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByRole('status')).toContainText('当前版本 v2');
  expect(body).toMatchObject({
    name: '国际工作区',
    settings: {
      budget_policy: { hard_limit: true, monthly_limit_cny: 50000 },
      default_platform_codes: ['official_site', 'zhihu'],
      review_policy: { minimum_approvals: 2, require_high_risk_signoff: true },
      schema_version: 'workspace-settings@1',
    },
    timezone: 'Asia/Tokyo',
  });
  expect(headers?.['if-match']).toBe('"1"');
  expect(headers?.['x-csrf-token']).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  await expect(page).toHaveURL(new RegExp(`id=${SECOND_ID}`, 'u'));
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

test('prevents archiving the final active workspace', async ({ page }) => {
  let archiveRequests = 0;
  await page.unroute('**/api/v1/workspaces?*');
  await page.route('**/api/v1/workspaces?*', async (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [workspace(FIRST_ID, '唯一工作区')],
        meta: { next_cursor: null, request_id: 'single-workspace' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route(`**/api/v1/workspaces/${FIRST_ID}/archive`, async (route) => {
    archiveRequests += 1;
    await route.abort();
  });
  await page.goto('/set-02');
  await expect(page.getByText('这是最后一个 active 工作区，不能归档。')).toBeVisible();
  await expect(page.getByRole('button', { name: '归档工作区' })).toBeDisabled();
  expect(archiveRequests).toBe(0);
});

test('archives a workspace with reason and current version when another active one remains', async ({
  page,
}) => {
  let body: Record<string, unknown> | undefined;
  let headers: Record<string, string> | undefined;
  await page.route(`**/api/v1/workspaces/${FIRST_ID}/archive`, async (route) => {
    body = route.request().postDataJSON() as Record<string, unknown>;
    headers = route.request().headers();
    await route.fulfill({
      body: JSON.stringify({
        data: { ...workspace(FIRST_ID, '主工作区'), status: 'archived', version: 2 },
        meta: { request_id: 'archive' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.goto('/set-02');
  page.once('dialog', (dialog) => dialog.accept('组织调整'));
  await page.getByRole('button', { name: '归档工作区' }).click();
  await expect(page.getByRole('status')).toContainText('工作区已归档');
  await expect(page.getByText('已归档工作区只可查看')).toBeVisible();
  expect(body).toEqual({ reason: '组织调整' });
  expect(headers?.['if-match']).toBe('"1"');
});

test('denies non-admin roles before loading workspaces', async ({ page }) => {
  let workspaceRequests = 0;
  await page.unroute('**/api/v1/workspaces?*');
  await page.route('**/api/v1/workspaces?*', async (route) => {
    workspaceRequests += 1;
    await route.abort();
  });
  await page.unroute('**/api/v1/auth/tenants');
  await page.route('**/api/v1/auth/tenants', async (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [
          {
            id: '20000000-0000-4000-8000-000000000099',
            is_active: true,
            last_used_at: null,
            name: '只读企业',
            role_code: 'viewer',
            slug: 'viewer',
          },
        ],
        meta: { request_id: 'viewer' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.goto('/set-02');
  await expect(page.getByRole('heading', { name: '无权管理工作区' })).toBeVisible();
  expect(workspaceRequests).toBe(0);
});

function workspace(id: string, name: string) {
  return {
    created_at: '2026-07-15T00:00:00.000Z',
    id,
    name,
    settings: {
      budget_policy: { hard_limit: false, monthly_limit_cny: null },
      default_platform_codes: ['official_site'],
      review_policy: { minimum_approvals: 1, require_high_risk_signoff: false },
      schema_version: 'workspace-settings@1',
    },
    slug: id === FIRST_ID ? 'main' : 'backup',
    status: 'active',
    tenant_id: '20000000-0000-4000-8000-000000000099',
    timezone: 'Asia/Shanghai',
    updated_at: '2026-07-15T01:00:00.000Z',
    version: 1,
  };
}
