import { expect, test, type Page, type Route } from '@playwright/test';

import { PlatformAccountResponseSchema } from './platform-account.schema';

const TENANT_ID = '10000000-0000-4000-8000-000000000091';
const WORKSPACE_ID = '20000000-0000-4000-8000-000000000091';
const ACCOUNT_ID = '30000000-0000-4000-8000-000000000091';
const SECRET = 'pub-01-super-secret-token';

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    { name: 'geo_csrf', url: 'http://127.0.0.1:34121', value: 'x'.repeat(43) },
  ]);
  await mockRole(page, 'publisher');
  await page.route('**/api/v1/workspaces?*', (route) =>
    json(route, {
      data: [workspace()],
      meta: { next_cursor: null, request_id: 'pub-workspaces' },
    }),
  );
});

test('connects an API account without ever echoing its credential', async ({ page }) => {
  let items: Record<string, unknown>[] = [];
  let createBody: Record<string, unknown> | undefined;
  await page.route('**/api/v1/platform-accounts**', async (route) => {
    if (route.request().method() === 'POST') {
      createBody = route.request().postDataJSON() as Record<string, unknown>;
      items = [account({ version: 1 })];
      await json(route, { data: items[0], meta: { request_id: 'account-create' } }, 201);
      return;
    }
    await json(route, { data: items, meta: { request_id: 'account-list' } });
  });

  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/pub-01');
  await expect(page.getByRole('heading', { name: '暂无平台账号' })).toBeVisible();
  await page.getByRole('button', { name: '连接账号' }).click();
  await page.getByLabel('工作区').last().selectOption(WORKSPACE_ID);
  await page.getByLabel('账号名称').fill('官网生产账号');
  await page.getByLabel('交付模式').selectOption('api');
  await page.getByLabel('API 地址').fill('https://publisher.example.test');
  await page.getByLabel('访问令牌').fill(SECRET);
  await page.getByRole('button', { name: '确认连接' }).click();

  await expect(page.getByText('平台账号已连接；凭证已安全保存且不会回显。')).toBeVisible();
  await expect(page.getByText('官网生产账号')).toBeVisible();
  await expect(page.getByLabel('访问令牌')).toHaveCount(0);
  await expect(page.getByText(SECRET, { exact: false })).toHaveCount(0);
  expect(createBody).toMatchObject({
    credential: { base_url: 'https://publisher.example.test', bearer_token: SECRET },
    display_name: '官网生产账号',
    platform_code: 'official_site',
    publish_mode: 'api',
    workspace_id: WORKSPACE_ID,
  });
  expect(JSON.stringify(items)).not.toContain(SECRET);
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

test('refreshes, tests and disables with CSRF and optimistic versions', async ({ page }) => {
  let current = account({ version: 1 });
  const writes: { body: unknown; headers: Record<string, string>; path: string }[] = [];
  await page.route('**/api/v1/platform-accounts**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      await json(route, { data: [current], meta: { request_id: 'account-list' } });
      return;
    }
    writes.push({
      body: request.postData() ? (request.postDataJSON() as unknown) : null,
      headers: request.headers(),
      path,
    });
    if (path.endsWith('/test')) {
      current = account({ version: current.version + 1 });
      await json(route, {
        data: {
          account_id: ACCOUNT_ID,
          capabilities: current.capabilities,
          checked_at: '2026-07-16T01:00:00.000Z',
          publish_mode: 'api',
          status: 'active',
          version: current.version,
        },
        meta: { request_id: 'account-test' },
      });
      return;
    }
    current = account({
      status: path.endsWith('/disable') ? 'disabled' : 'active',
      version: current.version + 1,
    });
    const response = { data: current, meta: { request_id: 'account-write' } };
    PlatformAccountResponseSchema.parse(response);
    await json(route, response);
  });

  await page.goto('/pub-01');
  const refreshResponse = page.waitForResponse((response) => response.url().endsWith('/refresh'));
  await page.getByRole('button', { name: '刷新授权' }).click();
  expect((await refreshResponse).ok()).toBe(true);
  await expect(page.getByText('授权状态已刷新。')).toBeVisible();
  await page.getByRole('button', { name: '能力测试' }).click();
  await expect(page.getByText('能力测试已完成。')).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept('账号停用'));
  await page.getByRole('button', { name: '禁用' }).click();
  await expect(page.getByText('平台账号已禁用。')).toBeVisible();
  await expect(page.getByText('账号已禁用', { exact: true })).toBeVisible();

  expect(writes.map(({ path }) => path)).toEqual([
    `/api/v1/platform-accounts/${ACCOUNT_ID}/refresh`,
    `/api/v1/platform-accounts/${ACCOUNT_ID}/test`,
    `/api/v1/platform-accounts/${ACCOUNT_ID}/disable`,
  ]);
  expect(writes.map(({ headers }) => headers['if-match'])).toEqual(['"1"', '"2"', '"3"']);
  expect(
    writes.every(({ headers }) => /^[A-Za-z0-9_-]{43}$/u.test(headers['x-csrf-token'] ?? '')),
  ).toBe(true);
  expect(writes[2]?.body).toEqual({ reason: '账号停用' });
  expect(JSON.stringify(writes)).not.toContain('credential_ciphertext');
});

test('persists platform, status and workspace filters in the URL', async ({ page }) => {
  const listUrls: string[] = [];
  await page.route('**/api/v1/platform-accounts**', async (route) => {
    listUrls.push(route.request().url());
    await json(route, { data: [], meta: { request_id: 'filtered-list' } });
  });

  await page.goto('/pub-01');
  const filters = page.getByRole('form', { name: '平台账号筛选' });
  await filters.getByRole('combobox', { name: '平台' }).selectOption('zhihu');
  await filters.getByRole('combobox', { name: '授权状态' }).selectOption('reauth');
  await filters.getByRole('combobox', { name: '工作区' }).selectOption(WORKSPACE_ID);
  await page.getByRole('button', { name: '应用筛选' }).click();

  await expect(page).toHaveURL(/platform_code=zhihu/u);
  await expect(page).toHaveURL(/status=reauth/u);
  await expect(page).toHaveURL(new RegExp(`workspace_id=${WORKSPACE_ID}`, 'u'));
  await expect.poll(() => listUrls.at(-1) ?? '').toContain('platform_code=zhihu');
  expect(listUrls.at(-1)).toContain('status=reauth');
  expect(listUrls.at(-1)).toContain(`workspace_id=${WORKSPACE_ID}`);
});

test('denies non-publisher roles before requesting account data', async ({ page }) => {
  let accountRequests = 0;
  await page.unroute('**/api/v1/auth/tenants');
  await mockRole(page, 'viewer');
  await page.route('**/api/v1/platform-accounts**', async (route) => {
    accountRequests += 1;
    await route.abort();
  });

  await page.goto('/pub-01');
  await expect(page.getByRole('heading', { name: '无权管理平台账号' })).toBeVisible();
  expect(accountRequests).toBe(0);
});

function account({
  status = 'active',
  version,
}: {
  status?: 'active' | 'disabled';
  version: number;
}) {
  return {
    capabilities: {
      export: true,
      get_status: true,
      metrics: true,
      publish: true,
      version: '1.0.0',
      warnings: [],
    },
    created_at: '2026-07-16T00:00:00.000Z',
    display_name: '官网生产账号',
    id: ACCOUNT_ID,
    platform_code: 'official_site',
    provider_account_id: 'site-main',
    publish_mode: 'api',
    scopes: ['publish'],
    status,
    tenant_id: TENANT_ID,
    timezone: 'Asia/Shanghai',
    token_expires_at: '2026-08-16T00:00:00.000Z',
    updated_at: '2026-07-16T00:00:00.000Z',
    version,
    workspace_id: WORKSPACE_ID,
  };
}

function workspace() {
  return {
    created_at: '2026-07-16T00:00:00.000Z',
    id: WORKSPACE_ID,
    name: '发布工作区',
    settings: { default_platform_codes: ['official_site'], schema_version: 'workspace-settings@1' },
    slug: 'publishing',
    status: 'active',
    tenant_id: TENANT_ID,
    timezone: 'Asia/Shanghai',
    updated_at: '2026-07-16T00:00:00.000Z',
    version: 1,
  };
}

async function mockRole(page: Page, role: string) {
  await page.route('**/api/v1/auth/tenants', (route) =>
    json(route, {
      data: [
        {
          id: TENANT_ID,
          is_active: true,
          last_used_at: null,
          name: '发布企业',
          role_code: role,
          slug: 'publisher',
        },
      ],
      meta: { request_id: 'role' },
    }),
  );
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}
