import { expect, test, type Page, type Route } from '@playwright/test';

const TENANT_ID = '10000000-0000-4000-8000-000000000088';
const PACKAGE_ID = '50000000-0000-4000-8000-000000000088';
const VARIANT_ID = '70000000-0000-4000-8000-000000000088';
const VERSION_ID = '80000000-0000-4000-8000-000000000088';
const CITATION_ID = '90000000-0000-4000-8000-000000000088';
const HASH = 'a'.repeat(64);

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    { name: 'geo_csrf', url: 'http://127.0.0.1:34118', value: 'x'.repeat(43) },
  ]);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'http://127.0.0.1:34118',
  });
  await mockRole(page, 'content_editor');
});

test('shows score, decision, issues, claims, evidence and every GEO subscore', async ({ page }) => {
  await mockDetail(page, 'block');
  await page.goto(`/qual-01?id=${VARIANT_ID}`);

  await expect(page.locator('strong').filter({ hasText: '72' })).toBeVisible();
  await expect(page.getByText('阻断', { exact: true })).toBeVisible();
  await expect(page.getByText('高风险声明缺少充分证据')).toBeVisible();
  await expect(page.getByText('产品事实声明')).toBeVisible();
  await expect(page.getByText('来自知识库的连续证据摘录。')).toBeVisible();
  await expect(page.getByText('GEO 总分')).toBeVisible();
  await expect(page.getByText('可读性与安全')).toBeVisible();
});

for (const decision of ['block', 'revise'] as const) {
  test(`${decision} decision cannot be submitted for review`, async ({ page }) => {
    await mockDetail(page, decision);
    await page.goto(`/qual-01?id=${VARIANT_ID}`);

    await expect(page.getByRole('button', { name: '提交审核' })).toBeDisabled();
    await expect(
      page.getByText(decision === 'block' ? '发现必须修改的问题' : '建议先处理下方问题'),
    ).toBeVisible();
  });
}

test('starts a full recheck and submits only a passing current report', async ({ page }) => {
  let recheck: unknown;
  let submitted: unknown;
  await mockDetail(page, 'pass');
  await page.route(`**/api/v1/content-variants/${VARIANT_ID}/quality-check`, async (route) => {
    recheck = route.request().postDataJSON();
    await json(route, { id: '61000000-0000-4000-8000-000000000088' }, 202);
  });
  await page.route(`**/api/v1/content-packages/${PACKAGE_ID}/submit-review`, async (route) => {
    submitted = route.request().postDataJSON();
    await json(route, { id: '62000000-0000-4000-8000-000000000088' }, 201);
  });
  await page.goto(`/qual-01?id=${VARIANT_ID}`);

  await page.getByRole('button', { name: '重新检查' }).click();
  await expect(page.getByText('质量检查已开始，完成后页面会自动刷新。')).toBeVisible();
  await page.getByRole('button', { name: '提交审核' }).click();
  await expect(page.getByText('内容已提交审核。')).toBeVisible();
  expect(recheck).toEqual({ mode: 'full' });
  expect(submitted).toEqual({ variant_ids: [VARIANT_ID] });
});

test('offers the first quality check instead of a dead-end empty report', async ({ page }) => {
  const base = detail('block');
  const withoutReport = {
    ...base,
    quality_report: null,
    variant: { ...base.variant, status: 'generated' },
  };
  let body: unknown;
  await page.route(`**/api/v1/content-variants/${VARIANT_ID}`, (route) =>
    json(route, withoutReport),
  );
  await page.route(`**/api/v1/content-variants/${VARIANT_ID}/quality-check`, async (route) => {
    body = route.request().postDataJSON();
    await json(route, { id: '61000000-0000-4000-8000-000000000089' }, 202);
  });
  await page.goto(`/qual-01?id=${VARIANT_ID}`);

  await expect(page.getByRole('heading', { name: '这份内容还没有质量报告' })).toBeVisible();
  await page.getByRole('button', { name: '开始质量检查' }).click();
  await expect(page.getByRole('heading', { name: '正在检查内容质量' })).toBeVisible();
  expect(body).toEqual({ mode: 'full' });
});

test('locates the issue and copies a truthful human adjudication request', async ({ page }) => {
  await mockDetail(page, 'block');
  await page.goto(`/qual-01?id=${VARIANT_ID}`);

  await expect(page.getByRole('link', { name: '定位问题' })).toHaveAttribute(
    'href',
    `/cont-05?id=${VARIANT_ID}&focus_block=intro#block-intro`,
  );
  await page.getByRole('button', { name: '复制事实复核摘要' }).click();
  await expect(page.getByText('事实复核摘要已复制，可发送给负责确认的同事。')).toBeVisible();
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(copied).toMatchObject({
    claims: [{ claim_key: 'claim-1', claim_text: '产品事实声明' }],
    variant_id: VARIANT_ID,
  });
});

test('allows tenant-member viewing while keeping mobile write actions safe', async ({ page }) => {
  await mockRole(page, 'viewer');
  await mockDetail(page, 'pass');
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`/qual-01?id=${VARIANT_ID}`);

  await expect(page.getByText('产品事实声明')).toBeVisible();
  await expect(page.getByRole('button', { name: '重新检查' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '提交审核' })).toBeDisabled();
  await expect(page.getByRole('link', { name: '定位问题' })).toHaveCount(0);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused();
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

async function mockDetail(page: Page, decision: 'pass' | 'revise' | 'block') {
  await page.route(`**/api/v1/content-variants/${VARIANT_ID}`, (route) =>
    json(route, detail(decision)),
  );
}

function detail(decision: 'pass' | 'revise' | 'block') {
  const status = decision === 'pass' ? 'quality_passed' : 'quality_failed';
  return {
    citations: [
      {
        chunk_id: '91000000-0000-4000-8000-000000000088',
        claim_key: 'claim-1',
        claim_text: '产品事实声明',
        content_version_id: VERSION_ID,
        created_at: '2026-07-15T01:00:00.000Z',
        id: CITATION_ID,
        quote_hash: HASH,
        quote_text: '来自知识库的连续证据摘录。',
        tenant_id: TENANT_ID,
      },
    ],
    current_content: contentVersion(),
    locks: [],
    quality_report: {
      checker_version: '1.0.0',
      content_version_id: VERSION_ID,
      created_at: '2026-07-15T01:05:00.000Z',
      decision,
      generation_run_id: '60000000-0000-4000-8000-000000000088',
      geo_scores: {
        answerability: 75,
        entity: 73,
        evidence: 62,
        platform_fit: 80,
        question: 76,
        readability_safety: 88,
        total: 72,
      },
      id: '92000000-0000-4000-8000-000000000088',
      issues:
        decision === 'pass'
          ? []
          : [
              {
                category: 'fact',
                citation_ids: [CITATION_ID],
                location: 'intro',
                message: '高风险声明缺少充分证据',
                rule_id: 'FACT_HIGH_RISK',
                severity: decision === 'block' ? 'BLOCK' : 'WARN',
                suggestion: '补充权威来源或降低声明强度。',
              },
            ],
      score: decision === 'pass' ? 93 : 72,
      tenant_id: TENANT_ID,
      variant_id: VARIANT_ID,
    },
    variant: {
      created_at: '2026-07-15T00:00:00.000Z',
      current_content_version_id: VERSION_ID,
      id: VARIANT_ID,
      is_required: true,
      package_id: PACKAGE_ID,
      platform_code: 'zhihu',
      quality_score: decision === 'pass' ? 93 : 72,
      status,
      tenant_id: TENANT_ID,
      updated_at: '2026-07-15T01:05:00.000Z',
      version: 4,
    },
    versions: [contentVersion()],
  };
}

function contentVersion() {
  return {
    blocks: [
      {
        block_key: 'intro',
        block_type: 'paragraph',
        content_version_id: VERSION_ID,
        created_at: '2026-07-15T00:00:00.000Z',
        id: '93000000-0000-4000-8000-000000000088',
        position: 0,
        tenant_id: TENANT_ID,
        text_hash: HASH,
      },
    ],
    content_hash: HASH,
    content_json: {
      blocks: [{ block_key: 'intro', block_type: 'paragraph', text: '正文' }],
      citation_map: [
        { citation_ids: [CITATION_ID], claim_key: 'claim-1', claim_text: '产品事实声明' },
      ],
      cta: null,
      hashtags: ['GEO'],
      platform_code: 'zhihu',
      platform_meta: { content_type: 'answer' },
      schema_version: 'content-writer-data@1',
      summary: '摘要',
      title: '质量报告测试内容',
    },
    created_at: '2026-07-15T00:00:00.000Z',
    created_by: '12000000-0000-4000-8000-000000000088',
    id: VERSION_ID,
    package_id: PACKAGE_ID,
    schema_version: 'content-writer-data@1',
    source_run_id: null,
    tenant_id: TENANT_ID,
    variant_id: VARIANT_ID,
    version_no: 1,
  };
}

async function mockRole(page: Page, role: string) {
  await page.route('**/api/v1/auth/tenants', (route) =>
    json(route, [
      {
        id: TENANT_ID,
        is_active: true,
        last_used_at: null,
        name: '质量企业',
        role_code: role,
        slug: 'quality',
      },
    ]),
  );
}
async function json(route: Route, data: unknown, status = 200) {
  await route.fulfill({
    body: JSON.stringify({ data, meta: { request_id: 'qual-01' } }),
    contentType: 'application/json',
    status,
  });
}
