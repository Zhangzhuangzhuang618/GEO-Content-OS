import { expect, test, type Page, type Route } from '@playwright/test';
const TENANT = '10000000-0000-4000-8000-000000000095',
  WORKSPACE = '20000000-0000-4000-8000-000000000095',
  BATCH = '30000000-0000-4000-8000-000000000095';
test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    { name: 'geo_csrf', url: 'http://127.0.0.1:34125', value: 'q'.repeat(43) },
  ]);
  await role(page, 'analyst');
  await page.route('**/api/v1/workspaces?*', (r) =>
    json(r, { data: [workspace()], meta: { next_cursor: null, request_id: 'w' } }),
  );
});
test('maps, previews and repeatedly imports the same dimensions idempotently', async ({ page }) => {
  const keys: string[] = [];
  await page.route('**/api/v1/metrics/import', async (r) => {
    keys.push(r.request().headers()['idempotency-key'] ?? '');
    await json(r, response(job('queued')), 201);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/anl-02');
  await page.getByLabel('CSV 文件').setInputFiles({
    name: 'metrics.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'platform_code,account_id,variant_id,metric_date,metric_name,metric_value\nzhihu,,,2026-07-15,reads,10\nzhihu,,,2026-07-15,reads,10\n',
    ),
  });
  await page.getByRole('button', { name: '校验并预览' }).click();
  await expect(page.getByText('校验通过，可提交导入。')).toBeVisible();
  await expect(page.getByText('zhihu').first()).toBeVisible();
  await page.getByRole('button', { name: '导入' }).click();
  await expect(page.getByText('重复文件将返回同一批次')).toBeVisible();
  await page.getByRole('button', { name: '导入' }).click();
  await expect(page.getByText(BATCH)).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys.every((k) => /^metrics-import-[0-9a-f-]{36}$/u.test(k))).toBe(true);
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});
test('shows batch errors and rolls back a succeeded batch idempotently', async ({ page }) => {
  let current = job('succeeded');
  let write: { body: unknown; key: string | undefined } = { body: null, key: undefined };
  await page.route(`**/api/v1/metrics/import-jobs/${BATCH}**`, async (r) => {
    if (r.request().method() === 'GET') {
      await json(r, response(current));
      return;
    }
    write = { body: r.request().postDataJSON(), key: r.request().headers()['idempotency-key'] };
    current = job('rolled_back');
    await json(r, response(current));
  });
  await page.goto(`/anl-02?workspace_id=${WORKSPACE}&batch_id=${BATCH}`);
  page.once('dialog', (d) => d.accept('错误来源批次'));
  await page.getByRole('button', { name: '回滚批次' }).click();
  await expect(page.getByText('批次已回滚')).toBeVisible();
  await expect(page.getByText('rolled_back')).toBeVisible();
  expect(write.body).toEqual({ reason: '错误来源批次' });
  expect(write.key).toMatch(new RegExp(`^metrics-rollback-${BATCH}-[0-9a-f-]{36}$`, 'u'));
});
test('denies a viewer before import data requests', async ({ page }) => {
  let requests = 0;
  await page.unroute('**/api/v1/auth/tenants');
  await role(page, 'viewer');
  await page.route('**/api/v1/metrics/**', async (r) => {
    requests++;
    await r.abort();
  });
  await page.goto(`/anl-02?batch_id=${BATCH}`);
  await expect(page.getByRole('heading', { name: '无权导入指标' })).toBeVisible();
  expect(requests).toBe(0);
});
function job(status: string) {
  return {
    content_hash: 'a'.repeat(64),
    created_at: '2026-07-16T00:00:00.000Z',
    error_json: null,
    id: BATCH,
    row_count: 2,
    source: 'csv',
    status,
    updated_at: '2026-07-16T00:01:00.000Z',
    workspace_id: WORKSPACE,
  };
}
function response(data: unknown) {
  return { data, meta: { request_id: 'batch' } };
}
function workspace() {
  return {
    created_at: '2026-07-16T00:00:00.000Z',
    id: WORKSPACE,
    name: '指标工作区',
    settings: { default_platform_codes: ['zhihu'], schema_version: 'workspace-settings@1' },
    slug: 'metrics',
    status: 'active',
    tenant_id: TENANT,
    timezone: 'Asia/Shanghai',
    updated_at: '2026-07-16T00:00:00.000Z',
    version: 1,
  };
}
async function role(page: Page, code: string) {
  await page.route('**/api/v1/auth/tenants', (r) =>
    json(r, {
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
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}
