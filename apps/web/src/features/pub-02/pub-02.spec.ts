import { expect, test, type Page, type Route } from '@playwright/test';

const TENANT_ID = '10000000-0000-4000-8000-000000000092';
const WORKSPACE_ID = '20000000-0000-4000-8000-000000000092';
const ACCOUNT_ID = '30000000-0000-4000-8000-000000000092';
const VARIANT_ID = '40000000-0000-4000-8000-000000000092';
const CONTENT_VERSION_ID = '50000000-0000-4000-8000-000000000092';
const USER_ID = '60000000-0000-4000-8000-000000000092';
const JOB_IDS = [
  '70000000-0000-4000-8000-000000000092',
  '71000000-0000-4000-8000-000000000092',
  '72000000-0000-4000-8000-000000000092',
] as const;

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    { name: 'geo_csrf', url: 'http://127.0.0.1:34122', value: 'y'.repeat(43) },
  ]);
  await mockRole(page, 'publisher');
  await page.route('**/api/v1/workspaces?*', (route) =>
    json(route, {
      data: [workspace()],
      meta: { next_cursor: null, request_id: 'calendar-workspaces' },
    }),
  );
  await page.route('**/api/v1/platform-accounts**', (route) =>
    json(route, { data: [account()], meta: { request_id: 'calendar-accounts' } }),
  );
});

test('blocks non-approved variants and creates an immediate job only after approval', async ({
  page,
}) => {
  let variantStatus = 'quality_passed';
  const creates: Record<string, unknown>[] = [];
  await page.route(`**/api/v1/content-variants/${VARIANT_ID}`, (route) =>
    json(route, {
      data: { variant: variant(variantStatus) },
      meta: { request_id: 'calendar-variant' },
    }),
  );
  await page.route('**/api/v1/publish-jobs**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await json(route, { data: [], meta: { next_cursor: null, request_id: 'calendar-list' } });
      return;
    }
    creates.push(request.postDataJSON() as Record<string, unknown>);
    await json(
      route,
      {
        data: job({ id: JOB_IDS[0], scheduledAt: new Date().toISOString() }),
        meta: { request_id: 'calendar-create' },
      },
      201,
    );
  });

  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/pub-02');
  const form = page.getByRole('form', { name: '创建发布排期' });
  await form.getByLabel('变体 UUID').fill(VARIANT_ID);
  await form.getByLabel('平台账号').selectOption(ACCOUNT_ID);
  await form.getByRole('button', { name: '立即发布' }).click();
  await expect(page.getByText('只有 approved 变体可排期或立即发布。')).toBeVisible();
  expect(creates).toHaveLength(0);

  variantStatus = 'approved';
  await form.getByRole('button', { name: '立即发布' }).click();
  await expect(page.getByText('立即发布任务已创建。')).toBeVisible();
  expect(creates).toHaveLength(1);
  expect(creates[0]).toMatchObject({ account_id: ACCOUNT_ID, variant_id: VARIANT_ID });
  expect(Number.isFinite(Date.parse(String(creates[0]?.['scheduled_at'])))).toBe(true);
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

test('reschedules, publishes now and cancels scheduled jobs through frozen APIs', async ({
  page,
}) => {
  let sequence = 0;
  let current: Record<string, unknown>[] = [
    job({ id: JOB_IDS[0], scheduledAt: '2026-07-18T02:00:00.000Z' }),
  ];
  const writes: { body: unknown; headers: Record<string, string>; path: string }[] = [];
  await page.route('**/api/v1/publish-jobs**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      await json(route, {
        data: current,
        meta: { next_cursor: null, request_id: 'calendar-list' },
      });
      return;
    }
    const body = request.postData() ? (request.postDataJSON() as unknown) : null;
    writes.push({ body, headers: request.headers(), path });
    if (path.endsWith('/cancel')) {
      const before =
        current[0] ??
        job({
          id: JOB_IDS[sequence] ?? JOB_IDS[2],
          scheduledAt: '2026-07-18T02:00:00.000Z',
        });
      current = [];
      await json(route, {
        data: { ...before, status: 'cancelled', version: Number(before['version']) + 1 },
        meta: { request_id: 'calendar-cancel' },
      });
      return;
    }
    sequence += 1;
    const requestBody = body as { scheduled_at: string };
    const created = job({
      id: JOB_IDS[sequence] ?? JOB_IDS[2],
      scheduledAt: requestBody.scheduled_at,
    });
    current = [created];
    await json(route, { data: created, meta: { request_id: 'calendar-create' } }, 201);
  });

  await page.goto('/pub-02');
  page.once('dialog', (dialog) => dialog.accept('2026-07-20T10:00'));
  await page.getByRole('button', { name: '改期' }).click();
  await expect(page.getByText('发布任务已改期。')).toBeVisible();

  const currentRow = page.getByRole('row').filter({ hasText: shortId(VARIANT_ID) });
  await currentRow.getByRole('button', { name: '立即发布' }).click();
  await expect(page.getByText('任务已调整为立即发布。')).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept('运营取消'));
  await page
    .getByRole('row')
    .filter({ hasText: shortId(VARIANT_ID) })
    .getByRole('button', { name: '取消' })
    .click();
  await expect(page.getByText('发布任务已取消。')).toBeVisible();
  await expect(page.getByRole('heading', { name: '暂无发布任务' })).toBeVisible();

  expect(writes.map(({ path }) => path)).toEqual([
    `/api/v1/publish-jobs/${JOB_IDS[0]}/cancel`,
    '/api/v1/publish-jobs',
    `/api/v1/publish-jobs/${JOB_IDS[1]}/cancel`,
    '/api/v1/publish-jobs',
    `/api/v1/publish-jobs/${JOB_IDS[2]}/cancel`,
  ]);
  expect(
    writes.filter(({ path }) => path.endsWith('/cancel')).map(({ headers }) => headers['if-match']),
  ).toEqual(['"1"', '"1"', '"1"']);
  expect(
    writes
      .filter(({ path }) => path === '/api/v1/publish-jobs')
      .every(({ headers }) =>
        /^publish-calendar-[0-9a-f-]{36}$/u.test(headers['idempotency-key'] ?? ''),
      ),
  ).toBe(true);
  expect((writes[0]?.body as { reason: string }).reason).toBe('发布日历改期');
  expect((writes[2]?.body as { reason: string }).reason).toBe('发布日历立即发布');
  expect((writes[4]?.body as { reason: string }).reason).toBe('运营取消');
});

test('persists calendar filters in the URL and forwards them to the list API', async ({ page }) => {
  const listUrls: string[] = [];
  await page.route('**/api/v1/publish-jobs**', async (route) => {
    listUrls.push(route.request().url());
    await json(route, { data: [], meta: { next_cursor: null, request_id: 'calendar-filtered' } });
  });

  await page.goto('/pub-02');
  const filters = page.getByRole('form', { name: '发布日历筛选' });
  await filters.getByRole('combobox', { exact: true, name: '平台' }).selectOption('official_site');
  await filters.getByRole('combobox', { exact: true, name: '平台账号' }).selectOption(ACCOUNT_ID);
  await filters.getByRole('combobox', { name: '任务状态' }).selectOption('scheduled');
  await filters.getByRole('combobox', { name: '工作区' }).selectOption(WORKSPACE_ID);
  await filters.getByLabel('开始时间').fill('2026-07-01T00:00');
  await filters.getByLabel('结束时间').fill('2026-08-01T00:00');
  await filters.getByRole('button', { name: '应用筛选' }).click();

  await expect(page).toHaveURL(/platform_code=official_site/u);
  await expect(page).toHaveURL(/status=scheduled/u);
  await expect(page).toHaveURL(new RegExp(`account_id=${ACCOUNT_ID}`, 'u'));
  await expect
    .poll(() => listUrls.at(-1) ?? '')
    .toContain('workspace_id=20000000-0000-4000-8000-000000000092');
  expect(listUrls.at(-1)).toContain('from=');
  expect(listUrls.at(-1)).toContain('to=');
});

test('denies non-publisher roles before requesting publishing data', async ({ page }) => {
  let publishingRequests = 0;
  await page.unroute('**/api/v1/auth/tenants');
  await mockRole(page, 'viewer');
  await page.route('**/api/v1/publish-jobs**', async (route) => {
    publishingRequests += 1;
    await route.abort();
  });

  await page.goto('/pub-02');
  await expect(page.getByRole('heading', { name: '无权查看发布日历' })).toBeVisible();
  expect(publishingRequests).toBe(0);
});

function job({ id, scheduledAt }: { id: string; scheduledAt: string }) {
  return {
    account_id: ACCOUNT_ID,
    attempt_count: 0,
    content_version_id: CONTENT_VERSION_ID,
    created_at: '2026-07-16T00:00:00.000Z',
    created_by: USER_ID,
    external_post_id: null,
    external_url: null,
    id,
    idempotency_key: `calendar-job-${id.slice(0, 8)}`,
    last_error: null,
    payload_hash: 'a'.repeat(64),
    scheduled_at: scheduledAt,
    status: 'scheduled',
    tenant_id: TENANT_ID,
    updated_at: '2026-07-16T00:00:00.000Z',
    variant_id: VARIANT_ID,
    version: 1,
  };
}

function variant(status: string) {
  return {
    created_at: '2026-07-16T00:00:00.000Z',
    current_content_version_id: CONTENT_VERSION_ID,
    id: VARIANT_ID,
    is_required: true,
    package_id: '80000000-0000-4000-8000-000000000092',
    platform_code: 'official_site',
    quality_score: 92,
    status,
    tenant_id: TENANT_ID,
    updated_at: '2026-07-16T00:00:00.000Z',
    version: 4,
  };
}

function account() {
  return {
    capabilities: { export: true, publish: true },
    created_at: '2026-07-16T00:00:00.000Z',
    display_name: '官网生产账号',
    id: ACCOUNT_ID,
    platform_code: 'official_site',
    provider_account_id: 'site-main',
    publish_mode: 'api',
    scopes: ['publish'],
    status: 'active',
    tenant_id: TENANT_ID,
    timezone: 'Asia/Shanghai',
    token_expires_at: '2026-08-16T00:00:00.000Z',
    updated_at: '2026-07-16T00:00:00.000Z',
    version: 1,
    workspace_id: WORKSPACE_ID,
  };
}

function workspace() {
  return {
    created_at: '2026-07-16T00:00:00.000Z',
    id: WORKSPACE_ID,
    name: '发布工作区',
    settings: { default_platform_codes: ['official_site'], schema_version: 'workspace-settings@1' },
    slug: 'publishing',
    status: 'active',
    tenant_id: TENANT_ID,
    timezone: 'Asia/Shanghai',
    updated_at: '2026-07-16T00:00:00.000Z',
    version: 1,
  };
}

async function mockRole(page: Page, role: string) {
  await page.route('**/api/v1/auth/tenants', (route) =>
    json(route, {
      data: [
        {
          id: TENANT_ID,
          is_active: true,
          last_used_at: null,
          name: '发布企业',
          role_code: role,
          slug: 'publisher',
        },
      ],
      meta: { request_id: 'calendar-role' },
    }),
  );
}

function shortId(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}
