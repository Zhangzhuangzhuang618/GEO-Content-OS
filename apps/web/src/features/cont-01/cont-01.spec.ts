import { expect, test, type Page } from '@playwright/test';

const TENANT_ID = '10000000-0000-4000-8000-000000000082';
const PROJECT_ID = '20000000-0000-4000-8000-000000000082';
const OWNER_ID = '30000000-0000-4000-8000-000000000082';
const FIRST_ID = '40000000-0000-4000-8000-000000000082';
const SECOND_ID = '50000000-0000-4000-8000-000000000082';
const NEXT_CURSOR = 'eyJwYWdlIjoyfQ';

test.beforeEach(async ({ page }) => {
  await mockRole(page, 'content_editor');
  await page.route('**/api/v1/briefs?*', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    await json(
      route,
      cursor ? [brief(SECOND_ID, '第二页 Brief')] : [brief(FIRST_ID, '第一页 Brief')],
      {
        next_cursor: cursor ? null : NEXT_CURSOR,
        request_id: 'briefs',
      },
    );
  });
});

test('keeps filters and cursor pagination reproducible in the URL', async ({ page }) => {
  await page.goto('/cont-01');
  await page.getByLabel('搜索标题').fill('GEO');
  await page.getByLabel('项目 UUID').fill(PROJECT_ID);
  await page.getByLabel('负责人 UUID').fill(OWNER_ID);
  await page.getByLabel('平台').selectOption('zhihu');
  await page.getByLabel('目标').selectOption('education');
  await page.getByRole('button', { name: '应用筛选' }).click();
  await expect(page).toHaveURL(
    new RegExp(
      `search=GEO.*project_id=${PROJECT_ID}.*platform_code=zhihu.*objective=education.*created_by=${OWNER_ID}`,
      'u',
    ),
  );

  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page).toHaveURL(new RegExp(`cursor=${NEXT_CURSOR}`, 'u'));
  await expect(page.getByRole('link', { name: '第二页 Brief' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: '第二页 Brief' })).toBeVisible();
  await page.getByRole('button', { name: '返回第一页' }).click();
  await expect(page).not.toHaveURL(/cursor=/u);
});

test('shows create and copy only to Brief managers', async ({ page }) => {
  await page.goto('/cont-01');
  await expect(page.getByRole('link', { name: '创建 Brief' })).toHaveAttribute('href', '/cont-02');
  await expect(page.getByRole('link', { name: '复制' })).toHaveAttribute(
    'href',
    `/cont-02?copy_from=${FIRST_ID}`,
  );

  await mockRole(page, 'viewer');
  await page.reload();
  await expect(page.getByRole('link', { name: '第一页 Brief' })).toBeVisible();
  await expect(page.getByRole('link', { name: '创建 Brief' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '复制' })).toHaveCount(0);
});

test('supports mobile table scrolling and keyboard entry', async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/cont-01');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

test('renders empty and permission states without leaking write actions', async ({ page }) => {
  await page.route('**/api/v1/briefs?*', (route) =>
    json(route, [], { next_cursor: null, request_id: 'empty' }),
  );
  await page.goto('/cont-01');
  await expect(page.getByRole('heading', { name: '暂无 Brief' })).toBeVisible();

  await page.route('**/api/v1/auth/tenants', (route) => route.fulfill({ status: 403 }));
  await page.reload();
  await expect(page.getByRole('heading', { name: '无权查看 Brief' })).toBeVisible();
  await expect(page.getByRole('link', { name: '创建 Brief' })).toHaveCount(0);
});

function brief(id: string, title: string) {
  return {
    audience: '企业内容运营与市场团队',
    constraints: {
      additional_instructions: null,
      cta: null,
      schema_version: 'brief-constraints@1',
    },
    created_at: '2026-07-15T00:00:00.000Z',
    created_by: OWNER_ID,
    due_at: null,
    id,
    keyword_ids: ['60000000-0000-4000-8000-000000000082'],
    objective: 'education',
    platform_codes: ['official_site', 'zhihu'],
    primary_keyword_id: '60000000-0000-4000-8000-000000000082',
    project_id: PROJECT_ID,
    source_ids: [],
    source_topic_candidate_id: null,
    tenant_id: TENANT_ID,
    title,
    updated_at: '2026-07-15T01:00:00.000Z',
    version: 1,
    workspace_id: '70000000-0000-4000-8000-000000000082',
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
