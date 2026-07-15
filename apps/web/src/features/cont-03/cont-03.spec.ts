import { expect, test, type Page, type Route } from '@playwright/test';

const TENANT_ID = '10000000-0000-4000-8000-000000000084';
const WORKSPACE_ID = '20000000-0000-4000-8000-000000000084';
const PROJECT_ID = '30000000-0000-4000-8000-000000000084';
const OWNER_ID = '40000000-0000-4000-8000-000000000084';
const PACKAGE_ID = '50000000-0000-4000-8000-000000000084';
const COPY_ID = '60000000-0000-4000-8000-000000000084';
const BRIEF_ID = '70000000-0000-4000-8000-000000000084';
const NEXT_CURSOR = 'eyJ1cGRhdGVkQXQiOiIyMDI2In0';

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    { name: 'geo_csrf', url: 'http://127.0.0.1:34113', value: 'x'.repeat(43) },
  ]);
  await mockRole(page, 'tenant_admin');
  await page.route('**/api/v1/content-packages?*', (route) =>
    json(route, [contentPackage(PACKAGE_ID)], {
      next_cursor: NEXT_CURSOR,
      request_id: 'packages',
    }),
  );
  await page.route(`**/api/v1/content-packages/${PACKAGE_ID}`, (route) =>
    json(route, packageDetail(PACKAGE_ID), { request_id: 'detail' }),
  );
  await page.route('**/api/v1/analytics/costs?*', (route) =>
    json(
      route,
      {
        breakdown: [],
        package_totals: [
          { cost_cents: 1234, currency: 'CNY', entry_count: 3, package_id: PACKAGE_ID },
        ],
        settled_only: true,
        totals: [],
      },
      { request_id: 'costs' },
    ),
  );
});

test('shows variant-derived quality and progress while package status remains a summary', async ({ page }) => {
  await page.goto('/cont-03');
  await expect(page.getByText('包状态由各平台变体投影得出，仅作列表摘要')).toBeVisible();
  await expect(page.getByRole('cell', { name: '已生成' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '85 分' })).toBeVisible();
  await expect(page.getByText('已产出 2/3')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'CNY 12.34' })).toBeVisible();
  await expect(page.getByRole('link', { name: '进入详情' })).toHaveAttribute(
    'href',
    `/cont-04?id=${PACKAGE_ID}`,
  );
});

test('keeps filters and cursor pagination reproducible', async ({ page }) => {
  await page.goto('/cont-03');
  await page.getByLabel('工作区 UUID').fill(WORKSPACE_ID);
  await page.getByLabel('项目 UUID').fill(PROJECT_ID);
  await page.getByLabel('负责人 UUID').fill(OWNER_ID);
  await page.getByLabel('包状态').selectOption('generated');
  await page.getByLabel('平台').selectOption('zhihu');
  await page.getByRole('button', { name: '应用筛选' }).click();
  await expect(page).toHaveURL(/workspace_id=.*project_id=.*created_by=.*status=generated.*platform_code=zhihu/u);
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page).toHaveURL(new RegExp(`cursor=${NEXT_CURSOR}`, 'u'));
  await page.reload();
  await expect(page.getByRole('cell', { name: '已生成' })).toBeVisible();
  await page.getByRole('button', { name: '返回第一页' }).click();
  await expect(page).not.toHaveURL(/cursor=/u);
});

test('copies through the frozen create-package contract', async ({ page }) => {
  let request: { readonly body: unknown; readonly headers: Record<string, string> } | undefined;
  await page.route('**/api/v1/content-packages', async (route) => {
    request = {
      body: route.request().postDataJSON(),
      headers: route.request().headers(),
    };
    await json(route, contentPackage(COPY_ID), { request_id: 'copy' }, 201);
  });
  await page.goto('/cont-03');
  await page.getByRole('button', { name: '复制' }).click();
  await expect(page.getByRole('link', { name: '查看副本' })).toHaveAttribute(
    'href',
    `/cont-04?id=${COPY_ID}`,
  );
  expect(request?.body).toEqual({
    brief_id: BRIEF_ID,
    project_id: PROJECT_ID,
    workspace_id: WORKSPACE_ID,
  });
  expect(request?.headers['idempotency-key']).toMatch(/^content-package-copy-/u);
  expect(request?.headers['x-csrf-token']).toBe('x'.repeat(43));
});

test('keeps read-only and access states safe on mobile', async ({ page }) => {
  await mockRole(page, 'viewer');
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/cont-03');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused();
  await expect(page.getByRole('button', { name: '复制' })).toHaveCount(0);
  await expect(page.getByRole('cell', { name: '无成本权限' })).toBeVisible();

  await page.unroute('**/api/v1/auth/tenants');
  await page.route('**/api/v1/auth/tenants', (route) => route.fulfill({ status: 403 }));
  await page.reload();
  await expect(page.getByRole('heading', { name: '无权查看内容包' })).toBeVisible();
});

function contentPackage(id: string) {
  return {
    brief_id: BRIEF_ID,
    created_at: '2026-07-15T00:00:00.000Z',
    created_by: OWNER_ID,
    id,
    master_content_version_id: null,
    project_id: PROJECT_ID,
    status: 'generated',
    tenant_id: TENANT_ID,
    updated_at: '2026-07-15T08:00:00.000Z',
    version: 1,
    workspace_id: WORKSPACE_ID,
  };
}

function packageDetail(id: string) {
  return {
    generation_runs: [],
    master_content: null,
    package: contentPackage(id),
    variants: [
      variant(id, 'official_site', 'generated', 80, '81000000-0000-4000-8000-000000000084'),
      variant(id, 'zhihu', 'quality_passed', 90, '82000000-0000-4000-8000-000000000084'),
      variant(id, 'douyin', 'generating', null, '83000000-0000-4000-8000-000000000084'),
    ],
  };
}

function variant(
  packageId: string,
  platform: string,
  status: string,
  quality: number | null,
  id: string,
) {
  return {
    created_at: '2026-07-15T00:00:00.000Z',
    current_content_version_id: null,
    id,
    is_required: true,
    package_id: packageId,
    platform_code: platform,
    quality_score: quality,
    status,
    tenant_id: TENANT_ID,
    updated_at: '2026-07-15T08:00:00.000Z',
    version: 1,
  };
}

async function mockRole(page: Page, role: string) {
  await page.route('**/api/v1/auth/tenants', (route) =>
    json(
      route,
      [
        {
          id: TENANT_ID,
          is_active: true,
          last_used_at: null,
          name: '内容企业',
          role_code: role,
          slug: 'content',
        },
      ],
      { request_id: 'role' },
    ),
  );
}

async function json(
  route: Route,
  data: unknown,
  meta: Record<string, unknown>,
  status = 200,
) {
  await route.fulfill({
    body: JSON.stringify({ data, meta }),
    contentType: 'application/json',
    status,
  });
}
