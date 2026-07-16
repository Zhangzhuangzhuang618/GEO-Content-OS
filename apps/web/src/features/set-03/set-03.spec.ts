import { expect, test } from '@playwright/test';

const USER = '10000000-0000-4000-8000-000000000100';
const PROMPT = '20000000-0000-4000-8000-000000000100';
const RULE = '30000000-0000-4000-8000-000000000100';

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    { name: 'geo_csrf', url: 'http://127.0.0.1:34129', value: 'x'.repeat(43) },
  ]);
  await page.route('**/api/v1/platform/prompt-versions?*', (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: { items: [promptVersion()], next_cursor: null },
        meta: { request_id: 'prompts' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route('**/api/v1/platform/rule-versions?*', (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: { items: [ruleVersion()], next_cursor: null },
        meta: { request_id: 'rules' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
});

test('shows version metadata on mobile and stores filters in the URL', async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/set-03');
  await expect(page.getByRole('heading', { name: '平台规则与 Prompt' })).toBeVisible();
  await expect(page.getByText('content-writer · v1.0.0')).toBeVisible();
  await expect(page.getByText('兼容 Schema：content-writer-data@1 · 资源版本 1')).toBeVisible();
  await page.getByLabel('状态筛选').selectOption('draft');
  await expect(page).toHaveURL(/tab=prompts.*status=draft/u);
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

test('creates and locally tests a Prompt without calling a model', async ({ page }) => {
  let createBody: Record<string, unknown> | undefined;
  let createHeaders: Record<string, string> | undefined;
  await page.route('**/api/v1/platform/prompt-versions', async (route) => {
    createBody = route.request().postDataJSON() as Record<string, unknown>;
    createHeaders = route.request().headers();
    await route.fulfill({
      body: JSON.stringify({
        data: promptVersion({
          change_summary: 'Add evidence checks',
          id: '21000000-0000-4000-8000-000000000100',
          semantic_version: '1.1.0',
        }),
        meta: { request_id: 'create' },
      }),
      contentType: 'application/json',
      status: 201,
    });
  });
  await page.goto('/set-03');
  await page.getByRole('button', { name: '创建新版本' }).click();
  await page.getByLabel('语义版本').fill('1.1.0');
  await page.getByLabel('兼容 Schema').fill('content-writer-data@1');
  await page.getByLabel('变更说明').fill('Add evidence checks');
  await page.getByLabel('System Prompt').fill('Use evidence.');
  await page.getByLabel('Task Template').fill('Write {{brief}}.');
  await page.getByRole('button', { name: '创建草稿' }).click();
  const created = page.locator('article').filter({ hasText: 'v1.1.0' });
  await created.getByRole('button', { name: '本地测试' }).click();
  await expect(page.getByRole('status')).toContainText('未调用模型或真实平台');
  expect(createBody).toMatchObject({
    change_summary: 'Add evidence checks',
    semantic_version: '1.1.0',
    skill_name: 'content-writer',
  });
  expect(createHeaders?.['idempotency-key']).toMatch(/^prompt-version-create-/u);
  expect(createHeaders?.['x-csrf-token']).toBe('x'.repeat(43));
});

test('publishes without exposing an overwrite action and supports audited retirement', async ({
  page,
}) => {
  let publishBody: Record<string, unknown> | undefined;
  let publishHeaders: Record<string, string> | undefined;
  let retireBody: Record<string, unknown> | undefined;
  await page.route(`**/api/v1/platform/prompt-versions/${PROMPT}/publish`, async (route) => {
    publishBody = route.request().postDataJSON() as Record<string, unknown>;
    publishHeaders = route.request().headers();
    await route.fulfill({
      body: JSON.stringify({
        data: promptVersion({
          published_at: '2026-07-16T02:00:00.000Z',
          published_by: USER,
          published_by_name: 'Platform Operator',
          status: 'published',
          version: 2,
        }),
        meta: { request_id: 'publish' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.route(`**/api/v1/platform/prompt-versions/${PROMPT}/retire`, async (route) => {
    retireBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      body: JSON.stringify({
        data: promptVersion({
          published_at: '2026-07-16T02:00:00.000Z',
          published_by: USER,
          published_by_name: 'Platform Operator',
          status: 'retired',
          version: 3,
        }),
        meta: { request_id: 'retire' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.goto('/set-03');
  const card = page.locator('article').filter({ hasText: 'content-writer · v1.0.0' });
  await card.getByRole('button', { name: '发布' }).click();
  await expect(card.getByText('已发布版本不可覆盖，只能退役或创建新版本。')).toBeVisible();
  await expect(card.getByRole('button', { name: '发布' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: /保存|编辑|覆盖/u })).toHaveCount(0);
  page.once('dialog', (dialog) => dialog.accept('Rollback due to quality regression'));
  await card.getByRole('button', { name: '退役/回滚' }).click();
  await expect(page.getByRole('status')).toContainText('已退役');
  expect(publishBody).toEqual({ version: 1 });
  expect(publishHeaders?.['if-match']).toBe('"1"');
  expect(retireBody).toEqual({ reason: 'Rollback due to quality regression' });
});

test('shows permission state when platform configuration access is denied', async ({ page }) => {
  await page.unroute('**/api/v1/platform/prompt-versions?*');
  await page.unroute('**/api/v1/platform/rule-versions?*');
  await page.route('**/api/v1/platform/**', (route) => route.fulfill({ status: 403 }));
  await page.goto('/set-03');
  await expect(page.getByRole('heading', { name: '无权管理平台配置' })).toBeVisible();
});

function promptVersion(overrides: Record<string, unknown> = {}) {
  return {
    change_summary: 'Initial content writer prompt',
    content_hash: 'a'.repeat(64),
    created_at: '2026-07-16T00:00:00.000Z',
    created_by: USER,
    created_by_name: 'Platform Operator',
    id: PROMPT,
    published_at: null,
    published_by: null,
    published_by_name: null,
    schema_version: 'content-writer-data@1',
    semantic_version: '1.0.0',
    skill_name: 'content-writer',
    status: 'draft',
    system_prompt: 'Use supplied evidence.',
    task_template: 'Write {{brief}}.',
    version: 1,
    ...overrides,
  };
}

function ruleVersion() {
  return {
    change_summary: 'Initial official site rules',
    content_hash: 'b'.repeat(64),
    created_at: '2026-07-16T00:00:00.000Z',
    created_by: USER,
    created_by_name: 'Platform Operator',
    id: RULE,
    platform_code: 'official_site',
    published_at: null,
    published_by: null,
    published_by_name: null,
    rules: { schema_version: 'platform-rules@1', title_max: 60 },
    semantic_version: '1.0.0',
    status: 'draft',
    version: 1,
  };
}
