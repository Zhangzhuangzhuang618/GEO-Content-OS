import { expect, test, type Page, type Route } from '@playwright/test';

const TENANT_ID = '10000000-0000-4000-8000-000000000087';
const PACKAGE_ID = '50000000-0000-4000-8000-000000000087';
const RUN_ID = '60000000-0000-4000-8000-000000000087';
const VARIANT_ID = '70000000-0000-4000-8000-000000000087';
const VERSION_ID = '80000000-0000-4000-8000-000000000087';
const HASH = 'a'.repeat(64);

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    { name: 'geo_csrf', url: 'http://127.0.0.1:34116', value: 'x'.repeat(43) },
  ]);
  await mockRole(page, 'tenant_owner');
});

test('shows status progress, model, settled cost, citations and lifecycle log', async ({
  page,
}) => {
  await mockRunPage(page, { run: run('running'), variantStatus: 'generating' });
  await page.goto(`/cont-06?id=${RUN_ID}`);

  await expect(page.getByRole('heading', { name: 'content-writer' })).toBeVisible();
  await expect(page.getByText('content-writer · 运行中')).toBeVisible();
  await expect(page.getByText('deepseek-v4-flash')).toBeVisible();
  await expect(page.getByLabel('状态进度 50%')).toBeVisible();
  await expect(page.getByText('USD 1.25')).toBeVisible();
  await expect(page.getByText('产品事实声明')).toBeVisible();
  await expect(page.getByText('由运行时间戳生成，不冒充模型提供方日志。')).toBeVisible();
  await expect(page.getByText('运行未记录错误。')).toBeVisible();
});

test('cancels with the run version and displays restored stable variant status', async ({
  page,
}) => {
  let cancelled = false;
  let cancellation:
    { readonly body: unknown; readonly headers: Record<string, string> } | undefined;
  await mockRunPage(page, {
    getRun: () => run(cancelled ? 'cancelled' : 'queued', cancelled ? 3 : 2),
    getVariantStatus: () => (cancelled ? 'generated' : 'generating'),
  });
  await page.route(`**/api/v1/generation-runs/${RUN_ID}/cancel`, async (route) => {
    cancellation = { body: route.request().postDataJSON(), headers: route.request().headers() };
    cancelled = true;
    await json(route, run('cancelled', 3));
  });

  await page.goto(`/cont-06?id=${RUN_ID}`);
  await page.getByLabel('取消原因').fill('人工终止测试');
  await page.getByRole('button', { name: '取消运行' }).click();

  await expect(page.getByText('运行已取消。')).toBeVisible();
  await expect(page.getByText('取消后变体已恢复：知乎 已生成')).toBeVisible();
  expect(cancellation?.headers['if-match']).toBe('"2"');
  expect(cancellation?.body).toEqual({ reason: '人工终止测试' });
});

test('retries one failed variant with its current version and frozen block locks', async ({
  page,
}) => {
  let regenerate: { readonly body: unknown; readonly headers: Record<string, string> } | undefined;
  await mockRunPage(page, { run: run('failed'), variantStatus: 'generation_failed' });
  await page.route(`**/api/v1/content-variants/${VARIANT_ID}/regenerate`, async (route) => {
    regenerate = { body: route.request().postDataJSON(), headers: route.request().headers() };
    await json(route, { id: '61000000-0000-4000-8000-000000000087' }, 202);
  });

  await page.goto(`/cont-06?id=${RUN_ID}`);
  await page.getByLabel('重试模型策略').selectOption('quality');
  await page.getByRole('button', { name: '重试知乎失败变体' }).click();

  await expect(page.getByText('失败变体的重试运行已创建。')).toBeVisible();
  expect(regenerate?.headers['if-match']).toBe('"4"');
  expect(regenerate?.body).toEqual({ locked_block_keys: ['intro'], model_policy: 'quality' });
});

test('disables cancellation for a terminal run and renders structured errors', async ({ page }) => {
  await mockRunPage(page, {
    run: { ...run('failed'), error: { code: 'MODEL_TIMEOUT', retryable: true } },
    variantStatus: 'generated',
  });
  await page.goto(`/cont-06?id=${RUN_ID}`);

  await expect(page.getByRole('button', { name: '取消运行' })).toBeDisabled();
  await expect(page.getByText('MODEL_TIMEOUT')).toBeVisible();
  await expect(page.getByText('当前运行已结束，且没有可重试的生成失败变体。')).toBeVisible();
});

test('keeps permission and mobile keyboard states safe', async ({ page }) => {
  await mockRole(page, 'viewer');
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`/cont-06?id=${RUN_ID}`);

  await expect(page.getByRole('heading', { name: '无权查看生成运行' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused();
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

async function mockRunPage(
  page: Page,
  input: {
    readonly getRun?: () => ReturnType<typeof run>;
    readonly getVariantStatus?: () => string;
    readonly run?: ReturnType<typeof run>;
    readonly variantStatus?: string;
  },
) {
  await page.route(`**/api/v1/generation-runs/${RUN_ID}`, (route) =>
    json(route, input.getRun?.() ?? input.run ?? run('running')),
  );
  await page.route(`**/api/v1/content-packages/${PACKAGE_ID}`, (route) =>
    json(route, packageDetail(input.getVariantStatus?.() ?? input.variantStatus ?? 'generating')),
  );
  await page.route(`**/api/v1/content-variants/${VARIANT_ID}`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return json(
      route,
      variantDetail(input.getVariantStatus?.() ?? input.variantStatus ?? 'generating'),
    );
  });
  await page.route('**/api/v1/analytics/costs?*', (route) => json(route, costs()));
}

function run(status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled', version = 2) {
  return {
    created_at: '2026-07-15T01:00:00.000Z',
    error: (status === 'cancelled'
      ? { code: 'USER_CANCELLED', message: '人工终止测试' }
      : null) as Record<string, unknown> | null,
    finished_at: ['succeeded', 'failed', 'cancelled'].includes(status)
      ? '2026-07-15T01:03:00.000Z'
      : null,
    id: RUN_ID,
    input_hash: HASH,
    model_key: 'deepseek-v4-flash',
    package_id: PACKAGE_ID,
    project_id: '30000000-0000-4000-8000-000000000087',
    prompt_version_id: '20000000-0000-4000-8000-000000000087',
    request_id: 'req-cont-06',
    skill_name: 'content-writer',
    skill_version: '1.2.0',
    started_at: status === 'queued' ? null : '2026-07-15T01:01:00.000Z',
    status,
    tenant_id: TENANT_ID,
    updated_at: '2026-07-15T01:02:00.000Z',
    variant_id: VARIANT_ID,
    version,
    workspace_id: '40000000-0000-4000-8000-000000000087',
  };
}

function packageDetail(status: string) {
  return {
    generation_runs: [run('running')],
    master_content: null,
    package: {
      brief_id: '11000000-0000-4000-8000-000000000087',
      created_at: '2026-07-15T00:00:00.000Z',
      created_by: '12000000-0000-4000-8000-000000000087',
      id: PACKAGE_ID,
      master_content_version_id: null,
      project_id: '30000000-0000-4000-8000-000000000087',
      status: status === 'generating' ? 'generating' : 'generated',
      tenant_id: TENANT_ID,
      updated_at: '2026-07-15T01:02:00.000Z',
      version: 3,
      workspace_id: '40000000-0000-4000-8000-000000000087',
    },
    variants: [variant(status)],
  };
}

function variantDetail(status: string) {
  return {
    citations: [
      {
        chunk_id: '90000000-0000-4000-8000-000000000087',
        claim_key: 'claim-1',
        claim_text: '产品事实声明',
        content_version_id: VERSION_ID,
        created_at: '2026-07-15T01:00:00.000Z',
        id: '91000000-0000-4000-8000-000000000087',
        quote_hash: HASH,
        quote_text: '来自知识库的证据摘录。',
        tenant_id: TENANT_ID,
      },
    ],
    current_content: null,
    locks: [
      {
        block_key: 'intro',
        created_at: '2026-07-15T00:00:00.000Z',
        id: '92000000-0000-4000-8000-000000000087',
        locked_by: '12000000-0000-4000-8000-000000000087',
        locked_content_hash: HASH,
        reason: null,
        tenant_id: TENANT_ID,
        updated_at: '2026-07-15T00:00:00.000Z',
        variant_id: VARIANT_ID,
      },
    ],
    quality_report: null,
    variant: variant(status),
    versions: [],
  };
}

function variant(status: string) {
  return {
    created_at: '2026-07-15T00:00:00.000Z',
    current_content_version_id: null,
    id: VARIANT_ID,
    is_required: true,
    package_id: PACKAGE_ID,
    platform_code: 'zhihu',
    quality_score: null,
    status,
    tenant_id: TENANT_ID,
    updated_at: '2026-07-15T01:02:00.000Z',
    version: 4,
  };
}

function costs() {
  return {
    breakdown: [
      {
        cost_category: 'model_token',
        cost_cents: 125,
        currency: 'USD',
        entry_count: 1,
        generation_run_id: RUN_ID,
        model_key: 'deepseek-v4-flash',
        package_id: PACKAGE_ID,
        project_id: '30000000-0000-4000-8000-000000000087',
        provider: 'deepseek',
        skill_name: 'content-writer',
        variant_id: VARIANT_ID,
        workspace_id: '40000000-0000-4000-8000-000000000087',
      },
    ],
    package_totals: [],
    settled_only: true,
    totals: [{ cost_cents: 125, currency: 'USD', entry_count: 1 }],
  };
}

async function mockRole(page: Page, role: string) {
  await page.route('**/api/v1/auth/tenants', (route) =>
    json(route, [
      {
        id: TENANT_ID,
        is_active: true,
        last_used_at: null,
        name: '内容企业',
        role_code: role,
        slug: 'content',
      },
    ]),
  );
}
async function json(route: Route, data: unknown, status = 200) {
  await route.fulfill({
    body: JSON.stringify({ data, meta: { request_id: 'cont-06' } }),
    contentType: 'application/json',
    status,
  });
}
