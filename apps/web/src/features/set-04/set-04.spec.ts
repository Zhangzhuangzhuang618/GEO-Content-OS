import { expect, test } from '@playwright/test';

const ACTOR = '10000000-0000-4000-8000-000000000100';
const RESOURCE = '20000000-0000-4000-8000-000000000100';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/audit-events?*', (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: { items: [auditEvent()], next_cursor: null },
        meta: { request_id: 'audit-page' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
});

test('shows immutable audit fields on mobile without mutation actions', async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/set-04');
  await expect(page.getByRole('heading', { exact: true, name: '审计日志' })).toBeVisible();
  await expect(page.getByText('审计事件只追加且不可编辑或删除')).toBeVisible();
  const card = page.locator('article');
  await expect(card.getByRole('heading', { name: 'workspace.updated' })).toBeVisible();
  await expect(card.getByText('Tenant Owner · workspace')).toBeVisible();
  await expect(card.getByText('req-audit-100')).toBeVisible();
  await expect(page.getByRole('button', { name: /编辑|删除|修改/u })).toHaveCount(0);
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

test('stores filters in the URL and sends deterministic audit query parameters', async ({
  page,
}) => {
  let requestUrl = '';
  await page.unroute('**/api/v1/audit-events?*');
  await page.route('**/api/v1/audit-events?*', (route) => {
    requestUrl = route.request().url();
    return route.fulfill({
      body: JSON.stringify({
        data: { items: [auditEvent()], next_cursor: null },
        meta: { request_id: 'filtered' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.goto('/set-04');
  await page.getByLabel('Actor ID').fill(ACTOR);
  await page.getByLabel('Action').fill('workspace.updated');
  await page.getByLabel('资源类型').fill('workspace');
  await page.getByLabel('Request ID').fill('req-audit-100');
  await page.getByLabel('开始日期').fill('2026-07-01');
  await page.getByRole('button', { name: '应用筛选' }).click();
  await expect(page).toHaveURL(/actor_id=.*action=workspace.updated.*resource_type=workspace/u);
  await expect.poll(() => requestUrl).toContain('action=workspace.updated');
  const url = new URL(requestUrl);
  expect(url.searchParams.get('actor_id')).toBe(ACTOR);
  expect(url.searchParams.get('from')).toBe('2026-07-01T00:00:00.000Z');
  expect(url.searchParams.get('request_id')).toBe('req-audit-100');
});

test('exports the currently loaded redacted audit results as CSV', async ({ page }) => {
  await page.goto('/set-04');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出当前结果 CSV' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^audit-events-\d{4}-\d{2}-\d{2}\.csv$/u);
  await expect(page.getByRole('status')).toContainText('已导出当前加载的 1 条审计事件');
});

test('shows permission and empty states', async ({ page }) => {
  await page.unroute('**/api/v1/audit-events?*');
  await page.route('**/api/v1/audit-events?*', (route) => route.fulfill({ status: 403 }));
  await page.goto('/set-04');
  await expect(page.getByRole('heading', { name: '无权查看审计日志' })).toBeVisible();

  await page.unroute('**/api/v1/audit-events?*');
  await page.route('**/api/v1/audit-events?*', (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: { items: [], next_cursor: null },
        meta: { request_id: 'empty' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.reload();
  await expect(page.getByRole('heading', { name: '暂无审计事件' })).toBeVisible();
});

function auditEvent() {
  return {
    action: 'workspace.updated',
    actor_id: ACTOR,
    actor_name: 'Tenant Owner',
    after: { name: 'After', token: '[REDACTED]' },
    before: { name: 'Before' },
    created_at: '2026-07-16T02:00:00.000Z',
    id: '30000000-0000-4000-8000-000000000100',
    ip: '127.0.0.1',
    request_id: 'req-audit-100',
    resource_id: RESOURCE,
    resource_type: 'workspace',
  };
}
