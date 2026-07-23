import { expect, test, type Page, type Route } from '@playwright/test';

const TENANT_ID = '10000000-0000-4000-8000-000000000085';
const WORKSPACE_ID = '20000000-0000-4000-8000-000000000085';
const PROJECT_ID = '30000000-0000-4000-8000-000000000085';
const OWNER_ID = '40000000-0000-4000-8000-000000000085';
const PACKAGE_ID = '50000000-0000-4000-8000-000000000085';
const BRIEF_ID = '60000000-0000-4000-8000-000000000085';
const SITE_ID = '70000000-0000-4000-8000-000000000085';
const ZHIHU_ID = '71000000-0000-4000-8000-000000000085';
const SITE_VERSION_ID = '80000000-0000-4000-8000-000000000085';
const ZHIHU_VERSION_ID = '81000000-0000-4000-8000-000000000085';
const RUN_ID = '90000000-0000-4000-8000-000000000085';
const HASH = 'a'.repeat(64);

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    { name: 'geo_csrf', url: 'http://127.0.0.1:34114', value: 'x'.repeat(43) },
  ]);
  await mockRole(page, 'content_editor');
  await mockDetail(page, baseDetail('generated', ['generated', 'quality_passed']));
});

test('renders human-readable content progress and guards actions by platform state', async ({
  page,
}) => {
  await page.goto(`/cont-04?id=${PACKAGE_ID}`);
  await expect(page.getByRole('heading', { name: '企业 GEO 内容母稿', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '通用初稿' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '各平台内容' })).toBeVisible();
  await expect(page.getByText('2 个平台')).toBeVisible();
  await expect(page.getByText('v1 / 共 1 版')).toHaveCount(2);
  await expect(page.getByRole('heading', { name: '处理记录' })).toBeVisible();
  await expect(page.getByText('当前阶段：已生成')).toBeVisible();
  await expect(page.getByText(PACKAGE_ID)).toHaveCount(0);
  await expect(page.getByText('content-writer')).toHaveCount(0);
  await expect(page.getByText('deepseek-v4-flash')).toHaveCount(0);

  await expect(page.getByRole('button', { name: '重新生成全部内容' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '检查内容质量' })).toBeEnabled();
  await expect(page.getByLabel('提交审核：官网')).toBeDisabled();
  await expect(page.getByLabel('提交审核：知乎')).toBeChecked();
  await expect(page.getByRole('button', { name: '提交审核' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '放弃本次创作' })).toBeDisabled();
});

test('submits only eligible quality-passed variants', async ({ page }) => {
  let body: unknown;
  await page.route(`**/api/v1/content-packages/${PACKAGE_ID}/submit-review`, async (route) => {
    body = route.request().postDataJSON();
    await json(route, { id: 'a0000000-0000-4000-8000-000000000085', version: 1 }, 201);
  });
  await page.goto(`/cont-04?id=${PACKAGE_ID}`);
  await page.getByRole('button', { name: '提交审核' }).click();
  await expect(page.getByText('所选平台内容已提交审核。')).toBeVisible();
  expect(body).toEqual({ variant_ids: [ZHIHU_ID] });
});

test('generates all required platforms with version and idempotency headers', async ({ page }) => {
  await page.unroute(`**/api/v1/content-packages/${PACKAGE_ID}`);
  await mockDetail(page, baseDetail('generated', ['generated', 'quality_failed']));
  let request: { readonly body: unknown; readonly headers: Record<string, string> } | undefined;
  await page.route(`**/api/v1/content-packages/${PACKAGE_ID}/generate`, async (route) => {
    request = { body: route.request().postDataJSON(), headers: route.request().headers() };
    await json(route, generationRun('queued'), 202);
  });
  await page.goto(`/cont-04?id=${PACKAGE_ID}`);
  await page.getByLabel('生成偏好').selectOption('quality');
  await page.getByRole('button', { name: '重新生成全部内容' }).click();
  await expect(page.getByText('内容生成已开始。')).toBeVisible();
  expect(request?.body).toEqual({
    locked_block_keys: [],
    model_policy: 'quality',
    platform_codes: ['official_site', 'zhihu'],
  });
  expect(request?.headers['if-match']).toBe('"3"');
  expect(request?.headers['idempotency-key']).toMatch(/^content-package-generate-/u);
});

test('starts quality checks for generated platforms and explains the next step', async ({
  page,
}) => {
  let body: unknown;
  await page.route(`**/api/v1/content-variants/${SITE_ID}/quality-check`, async (route) => {
    body = route.request().postDataJSON();
    await json(
      route,
      { ...generationRun('queued'), id: '91000000-0000-4000-8000-000000000085' },
      202,
    );
  });
  await page.goto(`/cont-04?id=${PACKAGE_ID}`);

  await expect(
    page.getByText(
      '普通平台按顺序完成质量检查和提交审核；已开启自动发布的官网内容会自行质检、重写并发布。',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: '检查内容质量' }).click();
  await expect(page.getByText('质量检查已开始，完成后页面会自动刷新。')).toBeVisible();
  expect(body).toEqual({ mode: 'full' });
});

test('identifies quality checks separately from content generation in history', async ({
  page,
}) => {
  await page.unroute(`**/api/v1/content-packages/${PACKAGE_ID}`);
  const detail = baseDetail('generated', ['generated', 'quality_passed']);
  detail.generation_runs.unshift({
    ...generationRun('failed'),
    id: '92000000-0000-4000-8000-000000000085',
    skill_name: 'quality-checker',
    variant_id: SITE_ID,
  });
  await mockDetail(page, detail);
  await page.goto(`/cont-04?id=${PACKAGE_ID}`);

  await expect(page.getByText('检查官网内容质量', { exact: true })).toBeVisible();
  await expect(page.getByText('生成官网内容', { exact: true })).toHaveCount(0);
});

test('explains when official-site automation needs human recovery after three rewrites', async ({
  page,
}) => {
  await page.unroute(`**/api/v1/content-packages/${PACKAGE_ID}`);
  const detail = baseDetail('generated', ['quality_failed', 'quality_passed']);
  await mockDetail(page, detail, {
    content_version_id: SITE_VERSION_ID,
    finished_at: '2026-07-15T08:00:00.000Z',
    id: '93000000-0000-4000-8000-000000000085',
    last_error: { code: 'QUALITY_GATE_FAILED' },
    publish_job_id: null,
    rewrite_count: 3,
    status: 'manual_required',
    updated_at: '2026-07-15T08:00:00.000Z',
  });

  await page.goto(`/cont-04?id=${PACKAGE_ID}`);
  await expect(page.getByRole('cell', { name: '官网自动流程' })).toBeVisible();
  await expect(page.getByText('需人工处理（已重写 3/3 次）')).toBeVisible();
  await expect(page.getByRole('link', { name: '查看问题并处理' })).toHaveAttribute(
    'href',
    `/qual-01?id=${SITE_ID}`,
  );
  await expect(page.getByLabel('提交审核：官网')).toBeDisabled();
  await expect(page.getByRole('button', { name: '检查内容质量' })).toBeEnabled();
});

test('allows exact draft abandonment and administrator archive only', async ({ page }) => {
  await page.unroute(`**/api/v1/content-packages/${PACKAGE_ID}`);
  await mockDetail(page, baseDetail('draft', ['draft', 'draft']));
  let abandonBody: unknown;
  await page.route(`**/api/v1/content-packages/${PACKAGE_ID}/abandon`, async (route) => {
    abandonBody = route.request().postDataJSON();
    await json(route, contentPackage('cancelled'), 200);
  });
  await page.goto(`/cont-04?id=${PACKAGE_ID}`);
  await expect(page.getByRole('button', { name: '放弃本次创作' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '归档任务' })).toHaveCount(0);
  await page.getByLabel('放弃或归档原因').fill('需求已撤回');
  await page.getByRole('button', { name: '放弃本次创作' }).click();
  expect(abandonBody).toEqual({ reason: '需求已撤回' });

  await mockRole(page, 'tenant_admin');
  let archiveRequest:
    { readonly body: unknown; readonly headers: Record<string, string> } | undefined;
  await page.route(`**/api/v1/content-packages/${PACKAGE_ID}/archive`, async (route) => {
    archiveRequest = { body: route.request().postDataJSON(), headers: route.request().headers() };
    await json(route, contentPackage('archived'), 200);
  });
  await page.reload();
  await expect(page.getByRole('button', { name: '归档任务' })).toBeEnabled();
  await page.getByLabel('放弃或归档原因').fill('周期结束');
  await page.getByRole('button', { name: '归档任务' }).click();
  expect(archiveRequest?.body).toEqual({ reason: '周期结束' });
  expect(archiveRequest?.headers['if-match']).toBe('"3"');
});

test('keeps viewer mobile and permission states read-only', async ({ page }) => {
  await mockRole(page, 'viewer');
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`/cont-04?id=${PACKAGE_ID}`);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused();
  await expect(page.getByRole('heading', { name: '下一步操作' })).toHaveCount(0);
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');

  await page.unroute('**/api/v1/auth/tenants');
  await page.route('**/api/v1/auth/tenants', (route) => route.fulfill({ status: 403 }));
  await page.reload();
  await expect(page.getByRole('heading', { name: '无权查看这项内容' })).toBeVisible();
});

async function mockDetail(
  page: Page,
  detail: ReturnType<typeof baseDetail>,
  siteAutomationRun: Record<string, unknown> | null = null,
) {
  await page.route(`**/api/v1/content-packages/${PACKAGE_ID}`, (route) => json(route, detail));
  await page.route(`**/api/v1/content-variants/${SITE_ID}`, (route) =>
    json(route, {
      ...variantDetail(detail.variants[0]!, SITE_VERSION_ID, false),
      automation_run: siteAutomationRun,
    }),
  );
  await page.route(`**/api/v1/content-variants/${ZHIHU_ID}`, (route) =>
    json(route, variantDetail(detail.variants[1]!, ZHIHU_VERSION_ID, true)),
  );
}

function baseDetail(packageStatus: string, statuses: readonly [string, string]) {
  return {
    generation_runs: [generationRun('succeeded')],
    master_content: contentVersion('82000000-0000-4000-8000-000000000085', null),
    package: contentPackage(packageStatus),
    variants: [
      variant(SITE_ID, 'official_site', statuses[0], SITE_VERSION_ID),
      variant(ZHIHU_ID, 'zhihu', statuses[1], ZHIHU_VERSION_ID),
    ],
  };
}

function contentPackage(status: string) {
  return {
    brief_id: BRIEF_ID,
    created_at: '2026-07-15T00:00:00.000Z',
    created_by: OWNER_ID,
    id: PACKAGE_ID,
    master_content_version_id: '82000000-0000-4000-8000-000000000085',
    project_id: PROJECT_ID,
    status,
    tenant_id: TENANT_ID,
    updated_at: '2026-07-15T08:00:00.000Z',
    version: 3,
    workspace_id: WORKSPACE_ID,
  };
}

function variant(id: string, platform: string, status: string, versionId: string) {
  return {
    created_at: '2026-07-15T00:00:00.000Z',
    current_content_version_id: status === 'draft' ? null : versionId,
    id,
    is_required: true,
    package_id: PACKAGE_ID,
    platform_code: platform,
    quality_score: status === 'quality_passed' ? 92 : null,
    status,
    tenant_id: TENANT_ID,
    updated_at: '2026-07-15T08:00:00.000Z',
    version: 2,
  };
}

function variantDetail(
  summary: ReturnType<typeof variant>,
  versionId: string,
  reviewable: boolean,
) {
  const current = summary.current_content_version_id ? contentVersion(versionId, summary.id) : null;
  return {
    automation_run: null,
    citations: reviewable
      ? [
          {
            chunk_id: 'b0000000-0000-4000-8000-000000000085',
            claim_key: 'claim-1',
            claim_text: '可追溯事实',
            content_version_id: versionId,
            created_at: '2026-07-15T07:00:00.000Z',
            id: 'b1000000-0000-4000-8000-000000000085',
            quote_hash: HASH,
            quote_text: '证据摘录',
            tenant_id: TENANT_ID,
          },
        ]
      : [],
    current_content: current,
    locks: [],
    quality_report: reviewable
      ? {
          content_version_id: versionId,
          decision: 'pass',
          id: 'b2000000-0000-4000-8000-000000000085',
          score: 92,
          variant_id: summary.id,
        }
      : null,
    variant: summary,
    versions: current ? [current] : [],
  };
}

function contentVersion(id: string, variantId: string | null) {
  return {
    blocks: [],
    content_hash: HASH,
    content_json: {
      blocks: [{ block_key: 'intro', block_type: 'paragraph', text: '内容' }],
      citation_map: [],
      cta: null,
      hashtags: [],
      platform_code: variantId ? 'zhihu' : 'master',
      platform_meta: {},
      schema_version: 'content-writer-data@1',
      summary: '统一母稿摘要',
      title: '企业 GEO 内容母稿',
    },
    created_at: '2026-07-15T06:00:00.000Z',
    created_by: OWNER_ID,
    id,
    package_id: PACKAGE_ID,
    schema_version: 'content-writer-data@1',
    source_run_id: RUN_ID,
    tenant_id: TENANT_ID,
    variant_id: variantId,
    version_no: 1,
  };
}

function generationRun(
  status: string,
): Record<string, unknown> & { skill_name: string; variant_id: string | null } {
  return {
    created_at: '2026-07-15T05:00:00.000Z',
    error: null,
    finished_at: status === 'succeeded' ? '2026-07-15T05:10:00.000Z' : null,
    id: RUN_ID,
    input_hash: HASH,
    model_key: 'flash',
    package_id: PACKAGE_ID,
    project_id: PROJECT_ID,
    prompt_version_id: 'c0000000-0000-4000-8000-000000000085',
    request_id: 'req-85',
    skill_name: 'content-writer',
    skill_version: '1.0.0',
    started_at: status === 'queued' ? null : '2026-07-15T05:01:00.000Z',
    status,
    tenant_id: TENANT_ID,
    updated_at: '2026-07-15T05:10:00.000Z',
    variant_id: null,
    version: 1,
    workspace_id: WORKSPACE_ID,
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
    body: JSON.stringify({ data, meta: { request_id: 'cont-04' } }),
    contentType: 'application/json',
    status,
  });
}
