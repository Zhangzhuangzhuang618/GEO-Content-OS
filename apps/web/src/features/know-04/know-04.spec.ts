import { expect, test } from '@playwright/test';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000081';
const PROJECT_ID = '20000000-0000-4000-8000-000000000081';
const FACT_ID = '30000000-0000-4000-8000-000000000081';
const OTHER_FACT_ID = '30000000-0000-4000-8000-000000000181';
const SOURCE_ID = '40000000-0000-4000-8000-000000000081';
const CHUNK_ID = '50000000-0000-4000-8000-000000000081';
const UPDATED_AT = '2026-07-15T01:00:00.000Z';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/auth/tenants', async (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [
          {
            id: '60000000-0000-4000-8000-000000000081',
            is_active: true,
            last_used_at: null,
            name: '事实企业',
            role_code: 'reviewer',
            slug: 'facts',
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
        data: [{ id: WORKSPACE_ID, name: '事实工作区', status: 'active' }],
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
  await page.route('**/api/v1/facts?*', async (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [fact(FACT_ID, '9.9'), fact(OTHER_FACT_ID, '12.9')],
        meta: { next_cursor: null, request_id: 'facts' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
});

test('shows competing values and traceable source chunks with reproducible filters', async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(
    `/know-04?workspace_id=${WORKSPACE_ID}&project_id=${PROJECT_ID}&status=candidate&search=价格`,
  );
  await expect(page.getByText('9.9 元', { exact: true })).toBeVisible();
  await expect(page.getByText('12.9 元', { exact: true })).toBeVisible();
  await expect(page.getByText('存在 1 个竞争值').first()).toBeVisible();
  await expect(page.getByRole('link', { name: '查看原始资料与 chunk' }).first()).toHaveAttribute(
    'href',
    `/know-03?id=${SOURCE_ID}&chunk=${CHUNK_ID}`,
  );
  await expect(page.getByLabel('状态')).toHaveValue('candidate');
  await expect(page.getByLabel('搜索')).toHaveValue('价格');
  await expect(page).toHaveURL(/status=candidate/u);
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

test('uses the audited adjudication endpoint with optimistic locking and preserves evidence', async ({
  page,
}) => {
  let requestBody: Record<string, unknown> | undefined;
  let requestHeaders: Record<string, string> | undefined;
  await page.route(`**/api/v1/facts/${FACT_ID}/verify`, async (route) => {
    requestBody = route.request().postDataJSON() as Record<string, unknown>;
    requestHeaders = route.request().headers();
    await route.fulfill({
      body: JSON.stringify({
        data: { ...fact(FACT_ID, '9.9'), evidence: undefined, status: 'verified' },
        meta: { request_id: 'adjudication' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.goto('/know-04');
  page.once('dialog', (dialog) => dialog.accept('已核对原始报价单'));
  await page
    .getByRole('listitem')
    .filter({ hasText: '9.9 元' })
    .getByRole('button', { name: '确认' })
    .click();
  await expect(page.getByRole('status')).toContainText('裁决前后值由服务端审计保留');
  expect(requestBody).toEqual({
    decision: 'verified',
    expected_updated_at: UPDATED_AT,
    reason: '已核对原始报价单',
  });
  expect(requestHeaders?.['if-match']).toBe(`"${UPDATED_AT}"`);
  expect(requestHeaders?.['x-csrf-token']).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(requestHeaders?.['idempotency-key']).toMatch(/^fact-adjudication-/u);
  await expect(page.getByRole('link', { name: '查看原始资料与 chunk' }).first()).toBeVisible();
});

test('denies roles without fact adjudication permission before loading scopes', async ({
  page,
}) => {
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
            id: '60000000-0000-4000-8000-000000000081',
            is_active: true,
            last_used_at: null,
            name: '只读企业',
            role_code: 'viewer',
            slug: 'viewer',
          },
        ],
        meta: { request_id: 'viewer-role' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.goto('/know-04');
  await expect(page.getByRole('heading', { name: '无权裁决事实' })).toBeVisible();
  expect(workspaceRequests).toBe(0);
});

function fact(id: string, value: string) {
  return {
    confidence: 0.92,
    created_at: '2026-07-15T00:00:00.000Z',
    evidence: [
      {
        chunk_id: CHUNK_ID,
        created_at: '2026-07-15T00:30:00.000Z',
        id:
          id === FACT_ID
            ? '70000000-0000-4000-8000-000000000081'
            : '70000000-0000-4000-8000-000000000181',
        quote_hash: 'a'.repeat(64),
        quote_text: `标准价格为 ${value} 元`,
        source_document_id: SOURCE_ID,
      },
    ],
    id,
    object_value: value,
    predicate: '标准价格',
    status: 'candidate',
    subject: '企业版',
    tenant_id: '60000000-0000-4000-8000-000000000081',
    unit: '元',
    updated_at: UPDATED_AT,
    valid_from: '2026-07-01',
    valid_to: null,
    workspace_id: WORKSPACE_ID,
  };
}
