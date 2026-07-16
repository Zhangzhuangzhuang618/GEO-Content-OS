import { expect, test, type Page, type Route } from '@playwright/test';

const TENANT = '10000000-0000-4000-8000-000000000096';
const WORKSPACE = '20000000-0000-4000-8000-000000000096';
const OBSERVATION = '30000000-0000-4000-8000-000000000096';
const ASSET = '40000000-0000-4000-8000-000000000096';
const HASH = 'a'.repeat(64);

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    { name: 'geo_csrf', url: 'http://127.0.0.1:34126', value: 'v'.repeat(43) },
  ]);
  await role(page, 'analyst');
  await page.route('**/api/v1/workspaces?*', (route) =>
    json(route, { data: [workspace()], meta: { next_cursor: null, request_id: 'workspace' } }),
  );
  await page.route('**/api/v1/visibility-observations/trend?*', (route) =>
    json(route, response([trendPoint()])),
  );
});

test('records screenshot evidence through the visibility API for object storage', async ({
  page,
}) => {
  let request: { body: Record<string, unknown>; key: string | undefined } | null = null;
  await page.route('**/api/v1/visibility-observations', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    request = {
      body: route.request().postDataJSON() as Record<string, unknown>,
      key: route.request().headers()['idempotency-key'],
    };
    await json(route, response(observation(true)), 201);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/anl-03');
  const form = page.getByRole('heading', { name: '录入观察' }).locator('..');
  await form.getByLabel('查询内容').fill('GEO Content OS');
  await form.getByLabel('排名').fill('2');
  await form.getByLabel('被引用').check();
  await form.getByLabel('证据截图').setInputFiles({
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    mimeType: 'image/png',
    name: 'evidence.png',
  });
  await form.getByRole('button', { name: '录入' }).click();
  await expect(page.getByText('截图已保存为对象存储证据')).toBeVisible();
  await expect(page.getByText(ASSET)).toBeVisible();
  expect(request).not.toBeNull();
  expect(request!.key).toMatch(/^visibility-create-[0-9a-f-]{36}$/u);
  expect(request!.body['screenshot']).toEqual({
    body_base64: 'iVBORw0KGgo=',
    mime_type: 'image/png',
  });
  await expect(page).toHaveURL(new RegExp(`workspace_id=${WORKSPACE}`, 'u'));
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

test('imports CSV atomically and writes trend filters to the URL', async ({ page }) => {
  let importedRows = 0;
  let importedWorkspace = '';
  let trendUrl = '';
  await page.route('**/api/v1/visibility-observations/import', async (route) => {
    const body = route.request().postDataJSON() as {
      rows?: unknown;
      workspace_id?: unknown;
    };
    importedRows = Array.isArray(body.rows) ? body.rows.length : 0;
    importedWorkspace = typeof body.workspace_id === 'string' ? body.workspace_id : '';
    await json(route, response([observation(false), { ...observation(false), id: ASSET }]), 201);
  });
  await page.unroute('**/api/v1/visibility-observations/trend?*');
  await page.route('**/api/v1/visibility-observations/trend?*', async (route) => {
    trendUrl = route.request().url();
    await json(route, response([trendPoint()]));
  });
  await page.goto('/anl-03');
  await page.getByLabel('CSV 文件').setInputFiles({
    buffer: Buffer.from(
      'query_text,platform_code,rank_position,is_cited,observed_at,notes\nGEO Content OS,zhihu,2,true,2026-07-15T08:00:00.000Z,证据命中\nGEO Content OS,zhihu,,false,2026-07-16T08:00:00.000Z,未命中\n',
    ),
    mimeType: 'text/csv',
    name: 'visibility.csv',
  });
  await expect(page.getByText('CSV 校验通过，共 2 行')).toBeVisible();
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await expect(page.getByText('已导入 2 条观察')).toBeVisible();
  expect(importedWorkspace).toBe(WORKSPACE);
  expect(importedRows).toBe(2);
  const filter = page.getByRole('form', { name: '可见性趋势筛选' });
  await filter.getByLabel('查询内容').fill('GEO Content OS');
  await filter.getByLabel('平台').selectOption('zhihu');
  await filter.getByRole('button', { name: '查看趋势' }).click();
  await expect(page).toHaveURL(/query_text=GEO\+Content\+OS/u);
  expect(trendUrl).toContain('query_text=GEO+Content+OS');
  expect(trendUrl).toContain('platform_code=zhihu');
});

test('denies a viewer before visibility data requests', async ({ page }) => {
  let requests = 0;
  await page.unroute('**/api/v1/auth/tenants');
  await role(page, 'viewer');
  await page.route('**/api/v1/visibility-observations/**', async (route) => {
    requests++;
    await route.abort();
  });
  await page.goto('/anl-03');
  await expect(page.getByRole('heading', { name: '无权访问可见性观察' })).toBeVisible();
  expect(requests).toBe(0);
});

function observation(withAsset: boolean) {
  return {
    created_at: '2026-07-16T08:01:00.000Z',
    evidence_asset_id: withAsset ? ASSET : null,
    id: OBSERVATION,
    is_cited: true,
    notes: null,
    observed_at: '2026-07-16T08:00:00.000Z',
    platform_code: 'zhihu',
    query_hash: HASH,
    query_text: 'GEO Content OS',
    rank_position: 2,
    tenant_id: TENANT,
    workspace_id: WORKSPACE,
  };
}
function trendPoint() {
  return {
    average_rank: 2.5,
    best_rank: 2,
    citation_count: 1,
    citation_rate: 0.5,
    day: '2026-07-16',
    observation_count: 2,
    platform_code: 'zhihu',
    query_hash: HASH,
    query_text: 'GEO Content OS',
  };
}
function workspace() {
  return {
    created_at: '2026-07-16T00:00:00.000Z',
    id: WORKSPACE,
    name: '可见性工作区',
    settings: { default_platform_codes: ['zhihu'], schema_version: 'workspace-settings@1' },
    slug: 'visibility',
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
          name: '分析企业',
          role_code: code,
          slug: 'analytics',
        },
      ],
      meta: { request_id: 'role' },
    }),
  );
}
function response(data: unknown) {
  return { data, meta: { request_id: 'visibility' } };
}
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}
