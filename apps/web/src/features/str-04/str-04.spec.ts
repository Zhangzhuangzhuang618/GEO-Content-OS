import { expect, test, type Page } from '@playwright/test';

const TENANT_ID = '10000000-0000-4000-8000-000000000077';
const PROJECT_ID = '20000000-0000-4000-8000-000000000077';
const KEYWORD_SET_ID = '30000000-0000-4000-8000-000000000077';
const KEYWORD_ID = '40000000-0000-4000-8000-000000000077';

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([{ name: 'geo_csrf', url: 'http://127.0.0.1:34110', value: 'csrf' }]);
  await mockRole(page, 'strategy_editor');
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
  await page.getByLabel('优先级').fill('90');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('关键词“GEO 内容”已更新。')).toBeVisible();

  await page.getByRole('button', { name: '禁用' }).click();
  await expect(page.getByText('关键词“GEO 内容”已禁用。')).toBeVisible();
  expect(bodies).toHaveLength(3);
  expect(bodies[0]).toEqual({
    keywords: [
      {
        intent: 'commercial',
        platform_scope: ['official_site', 'zhihu'],
        priority: 75,
        status: 'active',
        synonyms: ['内容自动化'],
        term: 'GEO 自动化',
      },
    ],
  });
  expect(bodies[1]).toMatchObject({ keywords: [{ priority: 90, term: 'GEO 内容' }] });
  expect(bodies[2]).toMatchObject({ keywords: [{ status: 'disabled', term: 'GEO 内容' }] });
});

test('writes filters to the URL and blocks non-manager roles on mobile', async ({ page }) => {
  await page.goto('/str-04');
  await page.getByLabel('项目 UUID（可选）').fill(PROJECT_ID);
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
    intent: 'informational',
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
