import { expect, test, type Page, type Route } from '@playwright/test';

const TENANT_ID = '10000000-0000-4000-8000-000000000089';
const WORKSPACE_ID = '20000000-0000-4000-8000-000000000089';
const FORBIDDEN_WORKSPACE_ID = '21000000-0000-4000-8000-000000000089';
const PROJECT_ID = '30000000-0000-4000-8000-000000000089';
const REVIEWER_ID = '40000000-0000-4000-8000-000000000089';
const SUBMITTER_ID = '41000000-0000-4000-8000-000000000089';
const SNAPSHOT_ID = '50000000-0000-4000-8000-000000000089';
const PACKAGE_ID = '60000000-0000-4000-8000-000000000089';
const PROFILE_ID = '70000000-0000-4000-8000-000000000089';
const PROMPT_ID = '80000000-0000-4000-8000-000000000089';
const NEXT_CURSOR = 'MjA';
const HASH = 'a'.repeat(64);

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    { name: 'geo_csrf', url: 'http://127.0.0.1:34119', value: 'x'.repeat(43) },
  ]);
  await mockRole(page, 'reviewer');
});

test('renders only API-authorized workspace snapshots and required inbox fields', async ({
  page,
}) => {
  await page.route('**/api/v1/review-snapshots?*', (route) =>
    json(route, [snapshot(WORKSPACE_ID)], { next_cursor: NEXT_CURSOR, request_id: 'inbox' }),
  );
  await page.goto('/rev-01');

  await expect(page.getByText(shortId(SNAPSHOT_ID))).toBeVisible();
  await expect(page.getByText(`工作区 ${shortId(WORKSPACE_ID)}`)).toBeVisible();
  await expect(page.getByText(FORBIDDEN_WORKSPACE_ID)).toHaveCount(0);
  await expect(page.getByText(SUBMITTER_ID)).toBeVisible();
  await expect(page.getByText('知乎、微信公众号')).toBeVisible();
  await expect(page.getByText('待处理 2')).toBeVisible();
  await expect(page.getByRole('link', { name: '进入快照' })).toHaveAttribute(
    'href',
    `/rev-02?id=${SNAPSHOT_ID}`,
  );
});

test('sends workspace filters and cursor so authorization remains server-enforced', async ({
  page,
}) => {
  const urls: string[] = [];
  await page.route('**/api/v1/review-snapshots?*', (route) => {
    urls.push(route.request().url());
    return json(route, [snapshot(WORKSPACE_ID)], {
      next_cursor: NEXT_CURSOR,
      request_id: 'inbox',
    });
  });
  await page.goto('/rev-01');
  await page.getByLabel('工作区 UUID').fill(WORKSPACE_ID);
  await page
    .getByRole('form', { name: '审核队列筛选' })
    .getByRole('combobox', { name: '风险', exact: true })
    .selectOption('high');
  await page.getByLabel('领取状态').selectOption('unclaimed');
  await page.getByRole('button', { name: '应用筛选' }).click();
  await expect(page).toHaveURL(/workspace_id=/u);
  await expect(page).toHaveURL(/risk_level=high/u);
  await expect(page).toHaveURL(/claim_state=unclaimed/u);
  await expect
    .poll(() => urls.some((url) => url.includes(`workspace_id=${WORKSPACE_ID}`)))
    .toBe(true);
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page).toHaveURL(new RegExp(`cursor=${NEXT_CURSOR}`, 'u'));
});

test('claims with triage, optimistic version and idempotency headers', async ({ page }) => {
  let request: { readonly body: unknown; readonly headers: Record<string, string> } | undefined;
  await page.route('**/api/v1/review-snapshots?*', (route) =>
    json(route, [snapshot(WORKSPACE_ID)], { next_cursor: null, request_id: 'inbox' }),
  );
  await page.route(`**/api/v1/review-snapshots/${SNAPSHOT_ID}/claim`, async (route) => {
    request = { body: route.request().postDataJSON(), headers: route.request().headers() };
    await json(
      route,
      {
        claimed_at: '2026-07-15T02:00:00.000Z',
        claimed_by: REVIEWER_ID,
        due_at: '2026-07-20T02:00:00.000Z',
        risk_level: 'high',
        snapshot_id: SNAPSHOT_ID,
        version: 2,
      },
      { request_id: 'claim' },
    );
  });
  await page.goto('/rev-01');
  await page.getByLabel(`风险 ${shortId(SNAPSHOT_ID)}`).selectOption('high');
  await page.getByLabel(`截止时间 ${shortId(SNAPSHOT_ID)}`).fill('2027-07-20T10:00');
  await page.getByRole('button', { name: '领取', exact: true }).click();
  await expect(page.getByText('审核任务已领取。')).toBeVisible();
  expect(request?.body).toEqual({ due_at: '2027-07-20T02:00:00.000Z', risk_level: 'high' });
  expect(request?.headers['if-match']).toBe('"1"');
  expect(request?.headers['idempotency-key']).toMatch(/^review-claim-/u);
  expect(request?.headers['x-csrf-token']).toBe('x'.repeat(43));
});

test('blocks non-review roles and preserves mobile keyboard access', async ({ page }) => {
  await mockRole(page, 'viewer');
  await page.goto('/rev-01');
  await expect(page.getByRole('heading', { name: '无权查看审核队列' })).toBeVisible();

  await page.unroute('**/api/v1/auth/tenants');
  await mockRole(page, 'tenant_admin');
  await page.route('**/api/v1/review-snapshots?*', (route) =>
    json(route, [snapshot(WORKSPACE_ID)], { next_cursor: null, request_id: 'inbox' }),
  );
  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused();
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

function snapshot(workspaceId: string) {
  return {
    brand_profile_id: PROFILE_ID,
    claimed_at: null,
    claimed_by: null,
    created_at: '2026-07-15T01:00:00.000Z',
    created_by: SUBMITTER_ID,
    due_at: null,
    id: SNAPSHOT_ID,
    model_key: 'deepseek-pro',
    package_id: PACKAGE_ID,
    pending_signoff_count: 2,
    platform_codes: ['zhihu', 'wechat_mp'],
    platform_rules_hash: HASH,
    project_id: PROJECT_ID,
    prompt_version_id: PROMPT_ID,
    quality_rules_hash: HASH,
    risk_level: null,
    snapshot_hash: HASH,
    status: 'in_review',
    tenant_id: TENANT_ID,
    updated_at: '2026-07-15T01:00:00.000Z',
    variant_count: 2,
    version: 1,
    workspace_id: workspaceId,
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
          name: '审核企业',
          role_code: role,
          slug: 'review',
        },
      ],
      { request_id: 'role' },
    ),
  );
}

async function json(route: Route, data: unknown, meta: Record<string, unknown>, status = 200) {
  await route.fulfill({
    body: JSON.stringify({ data, meta }),
    contentType: 'application/json',
    status,
  });
}
function shortId(id: string) {
  return id.slice(0, 8);
}
