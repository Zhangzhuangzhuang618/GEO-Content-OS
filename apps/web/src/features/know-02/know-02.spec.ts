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
            project_id: PROJECT_ID,
            title: '产品白皮书',
            status: 'processing',
            workspace_id: WORKSPACE_ID,
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
  await expect(page.getByText('资料“产品白皮书”已提交')).toBeVisible();
  await expect(page.getByText('当前进度：等待处理')).toBeVisible();
  await expect(page.getByText(/处理记录：50000000/u)).toBeHidden();
  expect(requestHeaders?.['x-csrf-token']).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(requestHeaders?.['content-type']).toContain('multipart/form-data');
  expect(bodyText).toContain('产品白皮书');
  expect(bodyText).toContain(PROJECT_ID);
  expect(bodyText).not.toContain('name="material_kind"');
});
test('requires certificate verification fields and explicit article-display consent', async ({
  page,
}) => {
  let uploads = 0;
  let bodyText = '';
  await page.route('**/api/v1/sources', async (route) => {
    uploads += 1;
    bodyText = route.request().postData() ?? '';
    await route.fulfill({
      body: JSON.stringify({
        data: {
          source: {
            id: '40000000-0000-4000-8000-000000000080',
            project_id: PROJECT_ID,
            title: '道路运输经营许可证',
            status: 'processing',
            workspace_id: WORKSPACE_ID,
          },
          ingest_job: { id: '50000000-0000-4000-8000-000000000080', status: 'queued' },
        },
        meta: { request_id: 'certificate-upload' },
      }),
      contentType: 'application/json',
      status: 201,
    });
  });
  await page.goto('/know-02');
  await page.getByLabel('标题').fill('道路运输经营许可证');
  await page.getByLabel('项目（可选）').selectOption(PROJECT_ID);
  await page.getByLabel('文件').setInputFiles({
    name: 'certificate.png',
    mimeType: 'image/png',
    buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
  });
  await expect(page.getByRole('heading', { name: '证照核验信息' })).toBeVisible();
  await expect(page.getByText(/资料图片.*最长边不超过 8192 像素/u)).toBeVisible();
  await page.getByLabel('证照名称').fill('道路运输经营许可证');
  await page.getByLabel('证照编号').fill('粤交运管许可字 2026-001');
  await page.getByLabel('持证主体').fill('广州示例搬家服务有限公司');
  await page.getByLabel('发证机关').fill('广州市交通运输局');
  await page.getByLabel('官方核验链接（可选）').fill('https://example.gov.cn/verify/2026-001');
  await page.getByLabel(/允许文章在实际引用/u).check();
  await page.getByRole('button', { name: '上传并创建解析任务' }).click();
  await expect(page.getByText('允许文章展示前必须完成公开内容确认。')).toBeVisible();
  expect(uploads).toBe(0);
  await page.getByLabel(/我确认有权公开/u).check();
  await page.getByRole('button', { name: '上传并创建解析任务' }).click();
  await expect(page.getByRole('status')).toContainText('安全扫描与解析任务已创建');
  expect(uploads).toBe(1);
  expect(bodyText).toContain('name="material_kind"');
  expect(bodyText).toContain('certificate');
  expect(bodyText).toContain('粤交运管许可字 2026-001');
  expect(bodyText).toContain('article_use_allowed');
  expect(bodyText).toContain('public_display_confirmed');
});
test('uploads insurance PDFs with a confirmed private-summary boundary', async ({ page }) => {
  let uploads = 0;
  let bodyText = '';
  await page.route('**/api/v1/sources', async (route) => {
    uploads += 1;
    bodyText = route.request().postData() ?? '';
    await route.fulfill({
      body: JSON.stringify({
        data: {
          source: {
            id: '40000000-0000-4000-8000-000000000084',
            project_id: PROJECT_ID,
            title: '企业保险证明',
            status: 'processing',
            workspace_id: WORKSPACE_ID,
          },
          ingest_job: { id: '50000000-0000-4000-8000-000000000084', status: 'queued' },
        },
        meta: { request_id: 'insurance-proof-upload' },
      }),
      contentType: 'application/json',
      status: 201,
    });
  });
  await page.goto('/know-02');
  await page.getByLabel('标题').fill('企业团体保险证明');
  await page.getByLabel('项目（可选）').selectOption(PROJECT_ID);
  await page.getByLabel('文件').setInputFiles({
    name: 'insurance-proof.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7 private employee list'),
  });
  await page.getByLabel('资料类型').selectOption('insurance_proof');
  await expect(page.getByRole('heading', { name: '保险证明脱敏摘要' })).toBeVisible();
  await expect(page.getByLabel('可信级别')).toHaveValue('verified');
  await expect(page.getByLabel('标题')).toHaveValue('企业保险证明');
  await expect(page.getByLabel('标题')).toHaveAttribute('readonly', '');
  await page.getByLabel('有效期开始').fill('2026-01-10');
  await page.getByLabel('有效期结束').fill('2027-01-09');
  await page.getByLabel('投保主体').fill('广州示例搬家服务有限公司');
  await page.getByLabel('承保机构').fill('示例人寿保险有限公司');
  await page.getByLabel('保险类型').fill('团体员工福利保险');
  await page.getByLabel('参保人数').fill('11');
  await page.getByRole('button', { name: '上传并创建解析任务' }).click();
  await expect(page.getByText('请确认仅允许脱敏摘要参与检索和生文。')).toBeVisible();
  expect(uploads).toBe(0);
  await page.getByLabel(/只允许系统生成的脱敏摘要/u).check();
  await page.getByRole('button', { name: '上传并创建解析任务' }).click();
  await expect(page.getByRole('status')).toContainText('安全扫描与解析任务已创建');
  expect(uploads).toBe(1);
  expect(bodyText).toContain('insurance_proof');
  expect(bodyText).toContain('企业保险证明');
  expect(bodyText).toContain('summary_use_confirmed');
  expect(bodyText).toContain('insured_count');
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
  await expect(page.getByText('处理技术信息')).toHaveCount(0);
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

test('previews and imports selected spreadsheet URL rows with visible per-row results', async ({
  page,
}) => {
  const uploadedUrls: string[] = [];
  await page.route('**/api/v1/sources/batch-url-preview', async (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: {
          duplicate_rows: 1,
          file_name: 'urls.xlsx',
          invalid_rows: 0,
          ready_rows: 2,
          rows: [
            {
              message: null,
              row_number: 5,
              status: 'ready',
              title: '企业官网',
              url: 'https://example.com/about',
            },
            {
              message: null,
              row_number: 6,
              status: 'ready',
              title: null,
              url: 'https://example.com/service',
            },
            {
              message: '文件内重复，已跳过',
              row_number: 7,
              status: 'duplicate',
              title: null,
              url: 'https://example.com/about',
            },
          ],
          sheet_name: '详细URL列表',
          sheets: ['综合汇总', '详细URL列表'],
          start_row: 5,
          title_column: null,
          total_rows: 3,
          url_column: 'D',
        },
        meta: { request_id: 'batch-preview' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route('**/api/v1/sources', async (route) => {
    const body = route.request().postData() ?? '';
    const url = body.includes('https://example.com/about')
      ? 'https://example.com/about'
      : 'https://example.com/service';
    uploadedUrls.push(url);
    const suffix = uploadedUrls.length === 1 ? '81' : '82';
    await route.fulfill({
      body: JSON.stringify({
        data: {
          ingest_job: {
            id: `50000000-0000-4000-8000-0000000000${suffix}`,
            status: 'queued',
          },
          source: {
            id: `40000000-0000-4000-8000-0000000000${suffix}`,
            project_id: PROJECT_ID,
            status: 'processing',
            title: url.endsWith('about') ? '企业官网' : 'example.com 网页资料',
            workspace_id: WORKSPACE_ID,
          },
        },
        meta: { request_id: `upload-${suffix}` },
      }),
      contentType: 'application/json',
      status: 201,
    });
  });

  await page.goto('/know-02?mode=batch-url');
  await page.getByLabel('XLSX 或 CSV 文件').setInputFiles({
    name: 'urls.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from('PK\u0003\u0004fixture'),
  });
  await page.getByRole('button', { name: '检查文件' }).click();
  await expect(page.getByText('可导入 2 条 · 无效 0 条 · 文件内重复 1 条')).toBeVisible();
  await page.getByRole('button', { name: '导入选中的 2 条' }).click();
  await expect(page.getByRole('status')).toContainText('导入完成：2 条资料已进入解析队列');
  await expect(page.getByText('已创建资料和解析任务')).toHaveCount(2);
  expect(uploadedUrls).toHaveLength(2);
});

test('waits and retries the same URL when batch import is rate limited', async ({ page }) => {
  let uploadAttempts = 0;
  await page.route('**/api/v1/sources/batch-url-preview', async (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: {
          duplicate_rows: 0,
          file_name: 'urls.xlsx',
          invalid_rows: 0,
          ready_rows: 1,
          rows: [
            {
              message: null,
              row_number: 5,
              status: 'ready',
              title: '等待后继续',
              url: 'https://example.com/rate-limited',
            },
          ],
          sheet_name: '详细URL列表',
          sheets: ['详细URL列表'],
          start_row: 5,
          title_column: null,
          total_rows: 1,
          url_column: 'D',
        },
        meta: { request_id: 'batch-preview-rate-limit' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route('**/api/v1/sources', async (route) => {
    uploadAttempts += 1;
    if (uploadAttempts === 1) {
      await route.fulfill({
        body: JSON.stringify({ error: { code: 'RATE_LIMITED' } }),
        contentType: 'application/json',
        headers: { 'retry-after': '0' },
        status: 429,
      });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({
        data: {
          ingest_job: {
            id: '50000000-0000-4000-8000-000000000083',
            status: 'queued',
          },
          source: {
            id: '40000000-0000-4000-8000-000000000083',
            project_id: PROJECT_ID,
            status: 'processing',
            title: '等待后继续',
            workspace_id: WORKSPACE_ID,
          },
        },
        meta: { request_id: 'upload-after-rate-limit' },
      }),
      contentType: 'application/json',
      status: 201,
    });
  });

  await page.goto('/know-02?mode=batch-url');
  await page.getByLabel('XLSX 或 CSV 文件').setInputFiles({
    name: 'urls.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from('PK\u0003\u0004fixture'),
  });
  await page.getByRole('button', { name: '检查文件' }).click();
  await page.getByRole('button', { name: '导入选中的 1 条' }).click();

  await expect(page.getByRole('status')).toContainText('导入完成：1 条资料已进入解析队列');
  await expect(page.getByText('已创建资料和解析任务')).toBeVisible();
  await expect(page.getByText('服务暂时不可用，请稍后重试')).toHaveCount(0);
  expect(uploadAttempts).toBe(2);
});
