import { expect, test } from '@playwright/test';

const USER = '10000000-0000-4000-8000-000000000102';
const TENANT = '20000000-0000-4000-8000-000000000102';
const GRANT = '30000000-0000-4000-8000-000000000102';

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    { name: 'geo_csrf', url: 'http://127.0.0.1:34130', value: 'x'.repeat(43) },
  ]);
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: {
          active_tenant_id: null,
          expires_at: '2026-07-16T10:00:00.000Z',
          user: { display_name: 'Platform Admin', email: 'admin@example.com', id: USER },
        },
        meta: { request_id: 'session' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route('**/api/v1/platform/tenants?*', (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: { items: [tenant()], next_cursor: null },
        meta: { request_id: 'tenants' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
});

test('shows tenant, plan, usage and health on mobile and persists filters', async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/plat-01');
  await expect(page.getByRole('heading', { name: '企业管理' })).toBeVisible();
  await expect(page.getByText('Acme China')).toBeVisible();
  await expect(page.getByText('¥12.34')).toBeVisible();
  await expect(page.locator('dd').filter({ hasText: /^健康$/u })).toBeVisible();
  await page.getByLabel('搜索企业').fill('Acme');
  await page.getByLabel('状态').selectOption('active');
  await page.getByRole('button', { name: '筛选' }).click();
  await expect(page).toHaveURL(/search=Acme.*status=active/u);
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

test('creates tenant with owner and default workspace through the frozen endpoint', async ({
  page,
}) => {
  let body: Record<string, unknown> | undefined;
  let headers: Record<string, string> | undefined;
  await page.route('**/api/v1/platform/tenants', async (route) => {
    body = route.request().postDataJSON() as Record<string, unknown>;
    headers = route.request().headers();
    await route.fulfill({
      body: JSON.stringify({
        data: tenant({
          id: '21000000-0000-4000-8000-000000000102',
          name: 'New Tenant',
          slug: 'new-tenant',
        }),
        meta: { request_id: 'create' },
      }),
      contentType: 'application/json',
      status: 201,
    });
  });
  await page.goto('/plat-01');
  await page.getByRole('button', { name: '创建企业' }).click();
  await page.getByLabel('企业名称').fill('New Tenant');
  await page.getByLabel('企业网址标识').fill('new-tenant');
  await page.getByLabel('管理员邮箱').fill('owner@new.example');
  await page.getByLabel('管理员姓名').fill('New Owner');
  await page.getByRole('button', { name: '确认创建' }).click();
  await expect(page.getByRole('status')).toContainText('默认工作区已创建');
  expect(body).toMatchObject({
    default_workspace_name: '默认工作区',
    name: 'New Tenant',
    owner_display_name: 'New Owner',
    owner_email: 'owner@new.example',
    slug: 'new-tenant',
  });
  expect(headers?.['idempotency-key']).toMatch(/^tenant-create-/u);
  expect(headers?.['x-csrf-token']).toBe('x'.repeat(43));
});

test('suspends with reason and optimistic version, then renders restore action', async ({
  page,
}) => {
  let body: Record<string, unknown> | undefined;
  let headers: Record<string, string> | undefined;
  await page.route(`**/api/v1/platform/tenants/${TENANT}/suspend`, async (route) => {
    body = route.request().postDataJSON() as Record<string, unknown>;
    headers = route.request().headers();
    await route.fulfill({
      body: JSON.stringify({
        data: tenant({
          health: { checked_at: '2026-07-16T01:00:00.000Z', status: 'suspended' },
          status: 'suspended',
          version: 2,
        }),
        meta: { request_id: 'suspend' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  page.on('dialog', (dialog) => dialog.accept('Payment overdue'));
  await page.goto('/plat-01');
  await page.getByRole('button', { name: '暂停' }).click();
  await expect(page.getByRole('button', { name: '恢复' })).toBeVisible();
  expect(body).toEqual({ reason: 'Payment overdue' });
  expect(headers?.['if-match']).toBe('"1"');
  expect(headers?.['x-csrf-token']).toBe('x'.repeat(43));
});

test('creates a grant capped at eight hours before any tenant-content read', async ({ page }) => {
  let body: Record<string, unknown> | undefined;
  let tenantContentReads = 0;
  await page.route('**/api/v1/platform/tenant-content/**', (route) => {
    tenantContentReads += 1;
    return route.abort();
  });
  await page.route('**/api/v1/platform/support-access-grants', async (route) => {
    body = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      body: JSON.stringify({
        data: {
          expires_at: String(body['expires_at']),
          id: GRANT,
          platform_user_id: USER,
          status: 'active',
          tenant_id: TENANT,
        },
        meta: { request_id: 'grant' },
      }),
      contentType: 'application/json',
      status: 201,
    });
  });
  await page.goto('/plat-01');
  await page.getByRole('button', { name: '申请限时支持授权' }).click();
  await page.getByLabel('授权原因').fill('Investigate customer-reported rendering issue');
  await page.getByLabel('有效时长').selectOption('8');
  const startedAt = Date.now();
  await page.getByRole('button', { name: '创建授权' }).click();
  await expect(page.getByText(/授权已生效，有效期至/u)).toBeVisible();
  const request = body as {
    expires_at: string;
    platform_user_id: string;
    scope: { permissions: string[]; resource_types: string[] };
    tenant_id: string;
  };
  expect(request.platform_user_id).toBe(USER);
  expect(request.tenant_id).toBe(TENANT);
  expect(request.scope).toEqual({
    permissions: ['content.read'],
    resource_types: ['tenant_content'],
  });
  expect(new Date(request.expires_at).getTime()).toBeGreaterThan(startedAt);
  expect(new Date(request.expires_at).getTime()).toBeLessThanOrEqual(
    startedAt + 8 * 60 * 60 * 1_000 + 2_000,
  );
  expect(tenantContentReads).toBe(0);
});

test('shows permission state when platform tenant access is denied', async ({ page }) => {
  await page.unroute('**/api/v1/platform/tenants?*');
  await page.route('**/api/v1/platform/tenants?*', (route) => route.fulfill({ status: 403 }));
  await page.goto('/plat-01');
  await expect(page.getByRole('heading', { name: '无权管理企业' })).toBeVisible();
});

function tenant(overrides: Record<string, unknown> = {}) {
  return {
    created_at: '2026-07-01T00:00:00.000Z',
    health: { checked_at: '2026-07-16T00:00:00.000Z', status: 'healthy' },
    id: TENANT,
    name: 'Acme China',
    plan_code: 'enterprise',
    slug: 'acme-china',
    status: 'active',
    timezone: 'Asia/Shanghai',
    updated_at: '2026-07-16T00:00:00.000Z',
    usage: {
      currency: 'CNY',
      ledger_entries: 8,
      period_end: '2026-08-01T00:00:00.000Z',
      period_start: '2026-07-01T00:00:00.000Z',
      settled_cost_cents: 1234,
    },
    version: 1,
    ...overrides,
  };
}
