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
  await page.route('**/api/v1/auth/session', (route) =>
    json(
      route,
      {
        active_tenant_id: TENANT_ID,
        expires_at: '2026-07-18T00:00:00.000Z',
        user: {
          display_name: '内容管理员',
          email: 'editor@example.com',
          id: OWNER_ID,
        },
      },
      { request_id: 'session' },
    ),
  );
  await page.route('**/api/v1/content-packages?*', (route) =>
    json(route, [contentPackageListItem(PACKAGE_ID)], {
      next_cursor: NEXT_CURSOR,
      request_id: 'packages',
    }),
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

test('shows a human-readable topic, progress and next action without UUIDs', async ({ page }) => {
  await page.goto('/cont-03');
  await expect(page.getByRole('heading', { name: '广州搬家公司怎么选' })).toBeVisible();
  await expect(page.getByText('已生成 2/3')).toBeVisible();
  await expect(page.getByText('85 分')).toBeVisible();
  await expect(page.getByText('CNY 12.34')).toBeVisible();
  await expect(page.getByText('由你创建')).toBeVisible();
  await expect(page.getByText(OWNER_ID)).toHaveCount(0);
  await expect(page.getByLabel('工作区 UUID')).toHaveCount(0);
  await expect(page.getByRole('link', { name: '继续完善内容' })).toHaveAttribute(
    'href',
    `/cont-04?id=${PACKAGE_ID}`,
  );
});

test('keeps each page within the rate-limit-safe package count', async ({ page }) => {
  const packageRequest = page.waitForRequest('**/api/v1/content-packages?*');
  await page.goto('/cont-03');
  const request = await packageRequest;
  expect(new URL(request.url()).searchParams.get('limit')).toBe('10');
});

test('shows the server retry window when the API rate limit is reached', async ({ page }) => {
  await page.unroute('**/api/v1/content-packages?*');
  await page.route('**/api/v1/content-packages?*', (route) =>
    route.fulfill({
      body: JSON.stringify({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests',
          request_id: 'rate-limited',
        },
      }),
      contentType: 'application/json',
      headers: { 'Retry-After': '23' },
      status: 429,
    }),
  );
  await page.goto('/cont-03');
  await expect(page.getByRole('heading', { name: '请求过于频繁' })).toBeVisible();
  await expect(page.getByText('请等待约 23 秒后刷新页面。')).toBeVisible();
});

test('recognizes rate limiting while loading the active tenant', async ({ page }) => {
  await page.unroute('**/api/v1/auth/tenants');
  await page.route('**/api/v1/auth/tenants', (route) => route.fulfill({ status: 429 }));
  await page.goto('/cont-03');
  await expect(page.getByRole('heading', { name: '请求过于频繁' })).toBeVisible();
  await expect(page.getByText('请稍后刷新页面。')).toBeVisible();
});

test('loads list summaries without per-package or per-brief requests', async ({ page }) => {
  const itemRequests: string[] = [];
  page.on('request', (request) => {
    if (
      request.url().includes(`/content-packages/${PACKAGE_ID}`) ||
      request.url().includes(`/briefs/${BRIEF_ID}`)
    ) {
      itemRequests.push(request.url());
    }
  });
  await page.goto('/cont-03');
  await expect(page.getByRole('heading', { name: '广州搬家公司怎么选' })).toBeVisible();
  expect(itemRequests).toEqual([]);
});

test('keeps filters and cursor pagination reproducible', async ({ page }) => {
  await page.goto('/cont-03');
  await page.getByText('查找和筛选内容').click();
  await page.getByLabel('搜索主题').fill('广州搬家');
  await page.getByLabel('当前进度').selectOption('generated');
  await page.getByRole('combobox', { name: '平台', exact: true }).selectOption('zhihu');
  await page.getByRole('button', { name: '查找' }).click();
  await expect(page).toHaveURL(/search=.*status=generated.*platform_code=zhihu/u);
  await page.getByRole('button', { name: '查看更早内容' }).click();
  await expect(page).toHaveURL(new RegExp(`cursor=${NEXT_CURSOR}`, 'u'));
  await page.reload();
  await expect(page.getByRole('heading', { name: '广州搬家公司怎么选' })).toBeVisible();
  await page.getByRole('button', { name: '返回最新内容' }).click();
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
  await page.getByRole('button', { name: '复制为新任务' }).click();
  await expect(page.getByRole('link', { name: '打开新任务' })).toHaveAttribute(
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
  await expect(page.getByRole('button', { name: '复制为新任务' })).toHaveCount(0);
  await expect(page.getByText('仅管理员可见')).toBeVisible();

  await page.unroute('**/api/v1/auth/tenants');
  await page.route('**/api/v1/auth/tenants', (route) => route.fulfill({ status: 403 }));
  await page.reload();
  await expect(page.getByRole('heading', { name: '无权查看当前内容' })).toBeVisible();
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

function contentPackageListItem(id: string) {
  return {
    ...contentPackage(id),
    brief_title: '广州搬家公司怎么选',
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

async function json(route: Route, data: unknown, meta: Record<string, unknown>, status = 200) {
  await route.fulfill({
    body: JSON.stringify({ data, meta }),
    contentType: 'application/json',
    status,
  });
}
