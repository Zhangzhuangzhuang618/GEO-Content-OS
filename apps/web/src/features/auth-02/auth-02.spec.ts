import { expect, test } from '@playwright/test';

const TENANT_A_ID = '10000000-0000-4000-8000-000000000001';
const TENANT_B_ID = '10000000-0000-4000-8000-000000000002';

test('shows only active memberships and switches an available tenant', async ({ page }) => {
  let switchCalls = 0;
  let switchRequest:
    | { readonly body: Record<string, unknown>; readonly headers: Record<string, string> }
    | undefined;
  await page.route('**/api/v1/auth/tenants', async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        data: [
          {
            id: TENANT_A_ID,
            is_active: true,
            last_used_at: '2026-07-14T08:00:00.000Z',
            name: '华东内容中心',
            role_code: 'tenant_admin',
            slug: 'east-content',
          },
          {
            id: TENANT_B_ID,
            is_active: false,
            last_used_at: null,
            name: '品牌增长团队',
            role_code: 'content_editor',
            slug: 'brand-growth',
          },
        ],
        meta: { request_id: 'request-auth-02-list' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.route('**/api/v1/auth/switch-tenant', async (route) => {
    switchCalls += 1;
    switchRequest = {
      body: route.request().postDataJSON() as Record<string, unknown>,
      headers: route.request().headers(),
    };
    await route.fulfill({
      body: JSON.stringify({
        data: { active_tenant_id: TENANT_B_ID },
        meta: { request_id: 'request-auth-02-switch' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto('/auth-02');
  await expect(page.getByRole('heading', { name: '华东内容中心' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '品牌增长团队' })).toBeVisible();
  await expect(page.getByText('已禁用企业')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '继续进入 华东内容中心' })).toBeEnabled();

  await page.getByRole('button', { name: '进入 品牌增长团队' }).click();
  await expect(page).toHaveURL(/\/dash-01$/u);
  expect(switchRequest?.body).toEqual({ tenant_id: TENANT_B_ID });
  expect(switchRequest?.headers['x-csrf-token']).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(switchRequest?.headers['idempotency-key']).toMatch(/^tenant-switch-[0-9a-f-]{36}$/u);

  await page.goto('/auth-02');
  await page.getByRole('button', { name: '继续进入 华东内容中心' }).click();
  await expect(page).toHaveURL(/\/dash-01$/u);
  expect(switchCalls).toBe(1);
});

test('renders empty and unauthenticated states without selectable tenants', async ({ page }) => {
  await page.route('**/api/v1/auth/tenants', async (route) => {
    await route.fulfill({
      body: JSON.stringify({ data: [], meta: { request_id: 'request-empty' } }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.goto('/auth-02');
  await expect(page.getByRole('heading', { name: '暂无可用企业' })).toBeVisible();
  await expect(page.getByRole('button', { name: /进入/u })).toHaveCount(0);

  await page.route('**/api/v1/auth/tenants', async (route) => {
    await route.fulfill({
      body: JSON.stringify({ error: { code: 'AUTH_REQUIRED' } }),
      contentType: 'application/json',
      status: 401,
    });
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: '登录状态已失效' })).toBeVisible();
  await expect(page.getByRole('link', { name: '返回登录' })).toHaveAttribute('href', '/auth-01');
});

test('recovers from load errors and supports mobile keyboard selection', async ({ page }) => {
  let attempts = 0;
  await page.setViewportSize({ height: 844, width: 390 });
  await page.route('**/api/v1/auth/tenants', async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({ status: 503 });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({
        data: [
          {
            id: TENANT_B_ID,
            is_active: false,
            last_used_at: null,
            name: '品牌增长团队',
            role_code: 'reviewer',
            slug: 'brand-growth',
          },
        ],
        meta: { request_id: 'request-retry' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto('/auth-02');
  await expect(page.getByRole('heading', { name: '暂时无法加载企业列表' })).toBeVisible();
  await page.getByRole('button', { name: '重新加载' }).click();
  const selectButton = page.getByRole('button', { name: '进入 品牌增长团队' });
  await expect(selectButton).toBeVisible();
  await selectButton.focus();
  await expect(selectButton).toBeFocused();
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});
