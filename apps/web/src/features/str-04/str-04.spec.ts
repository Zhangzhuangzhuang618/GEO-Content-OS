import { expect, test, type Page } from '@playwright/test';

const TENANT_ID = '10000000-0000-4000-8000-000000000077';
const WORKSPACE_ID = '15000000-0000-4000-8000-000000000077';
const PROJECT_ID = '20000000-0000-4000-8000-000000000077';
const KEYWORD_SET_ID = '30000000-0000-4000-8000-000000000077';
const KEYWORD_ID = '40000000-0000-4000-8000-000000000077';

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([{ name: 'geo_csrf', url: 'http://127.0.0.1:34110', value: 'csrf' }]);
  await mockRole(page, 'strategy_editor');
  await page.route('**/api/v1/workspaces?*', (route) =>
    json(route, [{ id: WORKSPACE_ID, name: '官网工作区', status: 'active' }], {
      request_id: 'workspaces',
    }),
  );
  await page.route('**/api/v1/projects?*', (route) =>
    json(route, [{ id: PROJECT_ID, name: '官网项目', status: 'active' }], {
      request_id: 'projects',
    }),
  );
  await page.route('**/api/v1/keyword-sets?*', (route) =>
    json(route, [keywordSet()], { next_cursor: null, request_id: 'sets' }),
  );
  await page.route(`**/api/v1/keyword-sets/${KEYWORD_SET_ID}`, (route) =>
    json(route, { ...keywordSet(), keywords: [keyword()] }, { request_id: 'detail' }),
  );
});

test('rejects normalized duplicate terms before sending a bulk request', async ({ page }) => {
  let writes = 0;
  await page.route(`**/api/v1/keyword-sets/${KEYWORD_SET_ID}/keywords`, (route) => {
    writes += 1;
    return route.fulfill({ status: 500 });
  });
  await page.goto('/str-04');
  await page
    .getByLabel('批量关键词')
    .fill(
      'GEO 内容\tinformational\t80\t生成式搜索\tofficial_site\tactive\ngeo 内容\tcommercial\t60\t\tzhihu\tactive',
    );
  await page.getByRole('button', { name: '导入关键词' }).click();
  await expect(page.getByText('第 2 行 term 在本次导入中重复。')).toBeVisible();
  expect(writes).toBe(0);
});

test('imports, edits and disables keywords through the frozen upsert endpoint', async ({
  page,
}) => {
  const bodies: unknown[] = [];
  await page.route(`**/api/v1/keyword-sets/${KEYWORD_SET_ID}/keywords`, async (route) => {
    bodies.push(route.request().postDataJSON());
    await json(route, [keyword()], { request_id: 'write' });
  });
  await page.goto('/str-04');
  await page
    .getByLabel('批量关键词')
    .fill('GEO 自动化\tcommercial\t75\t内容自动化\tofficial_site|zhihu\tactive');
  await page.getByRole('button', { name: '导入关键词' }).click();
  await expect(page.getByText('1 个关键词已导入或更新。')).toBeVisible();

  await page.getByRole('button', { name: '编辑' }).click();
  const editForm = page.getByRole('heading', { name: '编辑关键词' }).locator('..');
  await editForm.getByLabel('比较或选择服务').check();
  await editForm.getByLabel('优先级', { exact: true }).fill('90');
  await editForm.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('关键词“GEO 内容”已更新。')).toBeVisible();

  await page.getByRole('button', { name: '禁用' }).click();
  await expect(page.getByText('关键词“GEO 内容”已禁用。')).toBeVisible();
  expect(bodies).toHaveLength(3);
  expect(bodies[0]).toEqual({
    keywords: [
      {
        intents: ['commercial'],
        platform_scope: ['official_site', 'zhihu'],
        priority: 75,
        status: 'active',
        synonyms: ['内容自动化'],
        term: 'GEO 自动化',
      },
    ],
  });
  expect(bodies[1]).toMatchObject({
    keywords: [
      {
        intents: ['informational', 'commercial', 'transactional'],
        priority: 90,
        term: 'GEO 内容',
      },
    ],
  });
  expect(bodies[2]).toMatchObject({ keywords: [{ status: 'disabled', term: 'GEO 内容' }] });
});

test('exposes keyword management and supports a simple single-keyword form', async ({ page }) => {
  const bodies: unknown[] = [];
  await page.route(`**/api/v1/keyword-sets/${KEYWORD_SET_ID}/keywords`, async (route) => {
    bodies.push(route.request().postDataJSON());
    await json(route, [keyword()], { request_id: 'write' });
  });

  await page.goto('/str-04');
  await expect(page.getByRole('link', { name: '关键词管理' })).toBeVisible();
  await expect(page.getByText('了解知识或方法、准备咨询或下单')).toBeVisible();
  await page.getByLabel('关键词', { exact: true }).fill('广州搬家公司推荐');
  await page.getByLabel('了解知识或方法').check();
  await page.getByRole('button', { name: '添加关键词' }).click();
  await expect(page.getByText('关键词“广州搬家公司推荐”已添加。')).toBeVisible();
  expect(bodies[0]).toEqual({
    keywords: [
      {
        intents: ['informational', 'commercial'],
        platform_scope: ['official_site'],
        priority: 80,
        status: 'active',
        synonyms: [],
        term: '广州搬家公司推荐',
      },
    ],
  });
});

test('loads every keyword-set page and renders an adaptive selectable list', async ({ page }) => {
  const secondId = '30000000-0000-4000-8000-000000000078';
  await page.route('**/api/v1/keyword-sets?*', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (cursor) {
      await json(route, [{ ...keywordSet(), id: secondId, name: '长尾问题关键词' }], {
        next_cursor: null,
        request_id: 'sets-2',
      });
      return;
    }
    await json(route, [keywordSet()], { next_cursor: 'next-page', request_id: 'sets-1' });
  });
  await page.route(`**/api/v1/keyword-sets/${secondId}`, (route) =>
    json(
      route,
      { ...keywordSet(), id: secondId, keywords: [keyword()], name: '长尾问题关键词' },
      { request_id: 'detail-2' },
    ),
  );

  await page.goto('/str-04');
  const list = page.getByRole('region', { name: '关键词集列表' });
  await expect(list.getByText('共 2 个')).toBeVisible();
  await expect(list.getByRole('button')).toHaveCount(2);
  await list.getByRole('button', { name: /长尾问题关键词/u }).click();
  await expect(list.getByRole('button', { name: /长尾问题关键词/u })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('sizes the keyword table to its rows and paginates long lists', async ({ page }) => {
  const keywords = Array.from({ length: 12 }, (_, index) => ({
    ...keyword(),
    id: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    term: `关键词 ${index + 1}`,
  }));
  await page.route(`**/api/v1/keyword-sets/${KEYWORD_SET_ID}`, (route) =>
    json(route, { ...keywordSet(), keywords }, { request_id: 'paginated-detail' }),
  );

  await page.goto('/str-04');
  const list = page.getByRole('region', { name: '关键词列表' });
  const pagination = page.getByRole('navigation', { name: '关键词分页' });
  await expect(list).toHaveCSS('align-self', 'flex-start');
  await expect(pagination.getByText('第 1 / 2 页 · 共 12 个关键词')).toBeVisible();
  await expect(list.getByText('关键词 1', { exact: true })).toBeVisible();
  await expect(list.getByText('关键词 11', { exact: true })).toHaveCount(0);

  await pagination.getByRole('button', { name: '下一页' }).click();
  await expect(pagination.getByText('第 2 / 2 页 · 共 12 个关键词')).toBeVisible();
  await expect(list.getByText('关键词 1', { exact: true })).toHaveCount(0);
  await expect(list.getByText('关键词 11', { exact: true })).toBeVisible();
  await expect(pagination.getByRole('button', { name: '下一页' })).toBeDisabled();
});

test('creates the first keyword set for a selected project', async ({ page }) => {
  let createBody: unknown;
  await page.route('**/api/v1/keyword-sets?*', (route) =>
    json(route, [], { next_cursor: null, request_id: 'empty-sets' }),
  );
  await page.route('**/api/v1/keyword-sets', async (route) => {
    createBody = route.request().postDataJSON();
    await json(route, { ...keywordSet(), name: '官网核心关键词' }, { request_id: 'created-set' });
  });

  await page.goto('/str-04');
  await page.getByLabel('工作区').selectOption(WORKSPACE_ID);
  await page.getByLabel('项目').selectOption(PROJECT_ID);
  await page.getByRole('button', { name: '新建关键词集' }).click();
  await page.getByLabel('关键词集名称').fill('官网核心关键词');
  await page.getByRole('button', { name: '创建关键词集' }).click();

  await expect(
    page.getByText('关键词集“官网核心关键词”已创建，现在可以添加关键词。'),
  ).toBeVisible();
  expect(createBody).toEqual({ name: '官网核心关键词', project_id: PROJECT_ID });
});

test('writes filters to the URL and blocks non-manager roles on mobile', async ({ page }) => {
  await page.goto('/str-04');
  await page.getByLabel('工作区').selectOption(WORKSPACE_ID);
  await page.getByLabel('项目').selectOption(PROJECT_ID);
  await page.getByLabel('关键词集状态').selectOption('active');
  await page.getByRole('button', { name: '应用筛选' }).click();
  await expect(page).toHaveURL(new RegExp(`project_id=${PROJECT_ID}.*status=active`, 'u'));

  await mockRole(page, 'viewer');
  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload();
  await expect(page.getByRole('heading', { name: '无权管理关键词集' })).toBeVisible();
  await expect(page.getByRole('button', { name: '导入关键词' })).toHaveCount(0);
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

function keywordSet() {
  return {
    created_at: '2026-07-15T00:00:00.000Z',
    id: KEYWORD_SET_ID,
    name: '核心 GEO 关键词',
    project_id: PROJECT_ID,
    status: 'active',
    tenant_id: TENANT_ID,
    updated_at: '2026-07-15T01:00:00.000Z',
  };
}

function keyword() {
  return {
    created_at: '2026-07-15T00:00:00.000Z',
    id: KEYWORD_ID,
    intents: ['informational', 'transactional'],
    keyword_set_id: KEYWORD_SET_ID,
    platform_scope: ['official_site'],
    priority: 80,
    status: 'active',
    synonyms: ['生成式搜索'],
    tenant_id: TENANT_ID,
    term: 'GEO 内容',
    updated_at: '2026-07-15T01:00:00.000Z',
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
          name: '策略企业',
          role_code: role,
          slug: 'strategy',
        },
      ],
      { request_id: 'role' },
    ),
  );
}

async function json(
  route: Parameters<Parameters<Page['route']>[1]>[0],
  data: unknown,
  meta: Record<string, unknown>,
) {
  await route.fulfill({
    body: JSON.stringify({ data, meta }),
    contentType: 'application/json',
    status: 200,
  });
}
