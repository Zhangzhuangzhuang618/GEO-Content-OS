import { expect, test, type Page } from '@playwright/test';

const TENANT_ID = '10000000-0000-4000-8000-000000000083';
const WORKSPACE_ID = '20000000-0000-4000-8000-000000000083';
const PROJECT_ID = '30000000-0000-4000-8000-000000000083';
const BRIEF_ID = '40000000-0000-4000-8000-000000000083';
const KEYWORD_ID = '50000000-0000-4000-8000-000000000083';
const SOURCE_ID = '60000000-0000-4000-8000-000000000083';
const PACKAGE_ID = '70000000-0000-4000-8000-000000000083';

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([{ name: 'geo_csrf', url: 'http://127.0.0.1:34112', value: 'csrf' }]);
  await mockRole(page, 'content_editor');
  await mockChoices(page);
});

test('blocks missing platform, keyword and factual evidence before any write', async ({ page }) => {
  let writes = 0;
  await page.route('**/api/v1/briefs', (route) => {
    writes += 1;
    return route.fulfill({ status: 500 });
  });
  await page.goto('/cont-02');
  await fillScope(page);
  await page.getByLabel('主关键词').selectOption(KEYWORD_ID);
  await page.getByLabel('官网').uncheck();
  await page.getByRole('button', { name: '保存内容需求' }).click();
  await expect(page.getByText('请填写有效字段，并至少选择一个平台和一个关键词。')).toBeVisible();

  await page.getByLabel('官网').check();
  await page.getByRole('checkbox', { name: 'GEO 核心词' }).check();
  await page.getByLabel('主关键词').selectOption(KEYWORD_ID);
  await page.getByLabel('目标').selectOption('education');
  await page.getByRole('button', { name: '保存内容需求' }).click();
  await expect(page.getByText('事实型内容至少需要选择一份参考资料。')).toBeVisible();
  expect(writes).toBe(0);
});

test('estimates workload, saves a Brief and creates a content package', async ({ page }) => {
  let briefBody: Record<string, unknown> | undefined;
  let packageBody: Record<string, unknown> | undefined;
  await page.route('**/api/v1/briefs', async (route) => {
    briefBody = route.request().postDataJSON() as Record<string, unknown>;
    await json(route, brief(), 201);
  });
  await page.route('**/api/v1/content-packages', async (route) => {
    packageBody = route.request().postDataJSON() as Record<string, unknown>;
    await json(route, { id: PACKAGE_ID, status: 'draft' }, 201);
  });
  await page.goto('/cont-02');
  await fillValidBrief(page);
  await page.getByRole('button', { name: '预估成本' }).click();
  await expect(page.getByRole('heading', { name: '成本工作量预估' })).toBeVisible();
  await expect(
    page.getByText('这是工作量估算，实际费用以生成完成后的结算结果为准。'),
  ).toBeVisible();
  await page.getByRole('button', { name: '保存内容需求' }).click();
  await expect(page.getByText('内容需求已保存。')).toBeVisible();
  expect(briefBody).toMatchObject({
    keyword_ids: [KEYWORD_ID],
    objective: 'education',
    platform_codes: ['official_site'],
    source_ids: [SOURCE_ID],
  });

  await page.getByRole('button', { name: '创建内容任务' }).click();
  await expect(page.getByRole('link', { name: '查看内容任务' })).toHaveAttribute(
    'href',
    `/cont-04?id=${PACKAGE_ID}`,
  );
  expect(packageBody).toEqual({
    brief_id: BRIEF_ID,
    project_id: PROJECT_ID,
    workspace_id: WORKSPACE_ID,
  });
});

test('copies by reading the source and creating a new Brief', async ({ page }) => {
  let method = '';
  await page.route(`**/api/v1/briefs/${BRIEF_ID}`, (route) => json(route, brief(), 200));
  await page.route('**/api/v1/briefs', async (route) => {
    method = route.request().method();
    await json(
      route,
      { ...brief(), id: '80000000-0000-4000-8000-000000000083', title: '原始 Brief 副本' },
      201,
    );
  });
  await page.goto(`/cont-02?copy_from=${BRIEF_ID}`);
  await expect(page.getByText('正在创建内容需求副本，保存后将作为一条新需求。')).toBeVisible();
  await expect(page.getByLabel('标题')).toHaveValue('原始 Brief 副本');
  await page.getByRole('button', { name: '保存内容需求' }).click();
  await expect(page.getByText('内容需求已保存。')).toBeVisible();
  expect(method).toBe('POST');
});

test('updates with the current version and blocks viewer access on mobile', async ({ page }) => {
  let ifMatch = '';
  let updateBody: Record<string, unknown> | undefined;
  await page.route(`**/api/v1/briefs/${BRIEF_ID}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      ifMatch = route.request().headers()['if-match'] ?? '';
      updateBody = route.request().postDataJSON() as Record<string, unknown>;
      await json(route, { ...brief(), version: 4 }, 200);
    } else await json(route, brief(), 200);
  });
  await page.goto(`/cont-02?id=${BRIEF_ID}`);
  await page.getByLabel('标题').fill('更新后的 Brief');
  await page.getByRole('button', { name: '保存内容需求' }).click();
  expect(ifMatch).toBe('"3"');
  expect(updateBody).not.toHaveProperty('workspace_id');
  expect(updateBody).not.toHaveProperty('project_id');

  await mockRole(page, 'viewer');
  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload();
  await expect(page.getByRole('heading', { name: '无权编辑内容需求' })).toBeVisible();
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

async function fillScope(page: Page) {
  await page.getByLabel('标题').fill('企业 GEO 内容 Brief');
  await page.getByLabel('工作区').selectOption(WORKSPACE_ID);
  await page.getByLabel('项目').selectOption(PROJECT_ID);
  await page.getByLabel('受众').fill('企业内容运营与市场负责人团队');
}
async function fillValidBrief(page: Page) {
  await fillScope(page);
  await page.getByLabel('目标').selectOption('education');
  await page.getByRole('checkbox', { name: 'GEO 核心词' }).check();
  await page.getByLabel('主关键词').selectOption(KEYWORD_ID);
  await page.getByLabel('产品白皮书').check();
}

async function mockChoices(page: Page) {
  await page.route('**/api/v1/workspaces?*', (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [{ id: WORKSPACE_ID, name: '内容工作区', status: 'active' }],
        meta: { next_cursor: null, request_id: 'workspaces' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route('**/api/v1/projects?*', (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [{ id: PROJECT_ID, name: 'GEO 项目', status: 'active' }],
        meta: { request_id: 'projects' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  const keywordSet = {
    created_at: '2026-07-15T00:00:00.000Z',
    id: '51000000-0000-4000-8000-000000000083',
    name: '核心关键词',
    project_id: PROJECT_ID,
    status: 'active',
    tenant_id: TENANT_ID,
    updated_at: '2026-07-15T00:00:00.000Z',
  };
  await page.route('**/api/v1/keyword-sets?*', (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [keywordSet],
        meta: { next_cursor: null, request_id: 'keyword-sets' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route(`**/api/v1/keyword-sets/${keywordSet.id}/keywords?*`, (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [
          {
            created_at: '2026-07-15T00:00:00.000Z',
            id: KEYWORD_ID,
            intents: ['informational'],
            keyword_set_id: keywordSet.id,
            platform_scope: ['official_site'],
            priority: 80,
            status: 'active',
            synonyms: [],
            tenant_id: TENANT_ID,
            term: 'GEO 核心词',
            updated_at: '2026-07-15T00:00:00.000Z',
          },
        ],
        meta: { next_cursor: null, request_id: 'keyword-set' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route('**/api/v1/sources?*', (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [
          {
            content_hash: 'a'.repeat(64),
            created_at: '2026-07-15T00:00:00.000Z',
            created_by: TENANT_ID,
            effective_from: null,
            effective_to: null,
            id: SOURCE_ID,
            language: 'zh-CN',
            mime_type: 'application/pdf',
            parsed_at: null,
            project_id: null,
            source_type: 'pdf',
            status: 'active',
            tenant_id: TENANT_ID,
            title: '产品白皮书',
            trust_level: 'verified',
            updated_at: '2026-07-15T00:00:00.000Z',
            workspace_id: WORKSPACE_ID,
          },
        ],
        meta: { next_cursor: null, request_id: 'sources' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
}
function brief() {
  return {
    audience: '企业内容运营与市场负责人团队',
    constraints: {
      additional_instructions: null,
      cta: null,
      schema_version: 'brief-constraints@1',
    },
    created_at: '2026-07-15T00:00:00.000Z',
    created_by: '90000000-0000-4000-8000-000000000083',
    due_at: null,
    id: BRIEF_ID,
    keyword_ids: [KEYWORD_ID],
    objective: 'education',
    platform_codes: ['official_site'],
    primary_keyword_id: KEYWORD_ID,
    project_id: PROJECT_ID,
    source_ids: [SOURCE_ID],
    source_topic_candidate_id: null,
    tenant_id: TENANT_ID,
    title: '原始 Brief',
    updated_at: '2026-07-15T01:00:00.000Z',
    version: 3,
    workspace_id: WORKSPACE_ID,
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
      200,
    ),
  );
}
async function json(
  route: Parameters<Parameters<Page['route']>[1]>[0],
  data: unknown,
  status: number,
) {
  await route.fulfill({
    body: JSON.stringify({ data, meta: { request_id: 'test' } }),
    contentType: 'application/json',
    status,
  });
}
