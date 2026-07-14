import { expect, test } from '@playwright/test';
const WORKSPACE_ID = '10000000-0000-4000-8000-000000000079';
const PROJECT_ID = '20000000-0000-4000-8000-000000000079';
test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/auth/tenants', async (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [
          {
            id: '30000000-0000-4000-8000-000000000079',
            is_active: true,
            last_used_at: null,
            name: '资料企业',
            role_code: 'content_editor',
            slug: 'sources',
          },
        ],
        meta: { request_id: 'role' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route('**/api/v1/workspaces?*', async (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [{ id: WORKSPACE_ID, name: '资料工作区', status: 'active' }],
        meta: { request_id: 'workspaces' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route('**/api/v1/projects?*', async (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [{ id: PROJECT_ID, name: '产品项目', status: 'active' }],
        meta: { request_id: 'projects' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
});
test('rejects invalid file types and oversized files before upload', async ({ page }) => {
  let uploads = 0;
  await page.route('**/api/v1/sources', async (route) => {
    uploads += 1;
    await route.abort();
  });
  await page.goto('/know-02');
  await page.getByLabel('标题').fill('危险文件');
  await page.getByLabel('文件').setInputFiles({
    name: 'payload.exe',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('MZ'),
  });
  await page.getByRole('button', { name: '上传并创建解析任务' }).click();
  await expect(page.getByRole('status')).toContainText('扩展名与 MIME 类型');
  expect(uploads).toBe(0);
  await page.getByLabel('文件').setInputFiles({
    name: 'large.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.alloc(25 * 1024 * 1024 + 1),
  });
  await page.getByRole('button', { name: '上传并创建解析任务' }).click();
  await expect(page.getByRole('status')).toContainText('25 MiB');
  expect(uploads).toBe(0);
});
test('uploads multipart metadata and only reports success after an ingest job is returned', async ({
  page,
}) => {
  let requestHeaders: Record<string, string> | undefined;
  let bodyText = '';
  await page.route('**/api/v1/sources', async (route) => {
    requestHeaders = route.request().headers();
    bodyText = route.request().postData() ?? '';
    await route.fulfill({
      body: JSON.stringify({
        data: {
          source: {
            id: '40000000-0000-4000-8000-000000000079',
            title: '产品白皮书',
            status: 'processing',
          },
          ingest_job: { id: '50000000-0000-4000-8000-000000000079', status: 'queued' },
        },
        meta: { request_id: 'upload' },
      }),
      contentType: 'application/json',
      status: 201,
    });
  });
  await page.goto('/know-02');
  await page.getByLabel('标题').fill('产品白皮书');
  await page.getByLabel('项目（可选）').selectOption(PROJECT_ID);
  await page.getByLabel('文件').setInputFiles({
    name: 'whitepaper.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-test'),
  });
  await page.getByRole('button', { name: '上传并创建解析任务' }).click();
  await expect(page.getByRole('status')).toContainText('安全扫描与解析任务已创建');
  await expect(page.getByText(/解析任务：50000000/u)).toBeVisible();
  expect(requestHeaders?.['x-csrf-token']).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(requestHeaders?.['content-type']).toContain('multipart/form-data');
  expect(bodyText).toContain('产品白皮书');
  expect(bodyText).toContain(PROJECT_ID);
});
test('surfaces server virus or SSRF rejection without creating a fake job', async ({ page }) => {
  await page.route('**/api/v1/sources', async (route) =>
    route.fulfill({
      body: JSON.stringify({ error: { code: 'SCHEMA_VALIDATION_FAILED' } }),
      contentType: 'application/json',
      status: 422,
    }),
  );
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/know-02?mode=url');
  await page.getByLabel('标题').fill('内网资料');
  await page.getByLabel('URL').fill('http://127.0.0.1/private');
  await page.getByRole('button', { name: '上传并创建解析任务' }).click();
  await expect(page.getByRole('status')).toContainText('病毒或 URL 安全校验未通过');
  await expect(page.getByText(/解析任务：/u)).toHaveCount(0);
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});
test('denies read-only roles before loading upload choices', async ({ page }) => {
  let workspaceRequests = 0;
  await page.unroute('**/api/v1/workspaces?*');
  await page.route('**/api/v1/workspaces?*', async (route) => {
    workspaceRequests += 1;
    await route.abort();
  });
  await page.unroute('**/api/v1/auth/tenants');
  await page.route('**/api/v1/auth/tenants', async (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [
          {
            id: '30000000-0000-4000-8000-000000000079',
            is_active: true,
            last_used_at: null,
            name: '只读企业',
            role_code: 'viewer',
            slug: 'read-only',
          },
        ],
        meta: { request_id: 'viewer-role' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.goto('/know-02');
  await expect(page.getByRole('heading', { name: '无权上传资料' })).toBeVisible();
  await expect(page.getByRole('button', { name: '上传并创建解析任务' })).toHaveCount(0);
  expect(workspaceRequests).toBe(0);
});
