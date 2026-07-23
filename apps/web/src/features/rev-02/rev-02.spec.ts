import { expect, test, type Page, type Route } from '@playwright/test';
const T = '10000000-0000-4000-8000-000000000090',
  S = '50000000-0000-4000-8000-000000000090',
  V = '60000000-0000-4000-8000-000000000090',
  SV = '61000000-0000-4000-8000-000000000090',
  CV = '62000000-0000-4000-8000-000000000090',
  H = 'a'.repeat(64);
const BASE_URL = process.env.REV02_BASE_URL ?? 'http://127.0.0.1:34121';
test.beforeEach(async ({ context, page }) => {
  await context.addCookies([{ name: 'geo_csrf', url: BASE_URL, value: 'x'.repeat(43) }]);
  await role(page, 'reviewer');
  await page.route(`**/api/v1/review-snapshots/${S}`, (route) => json(route, detail()));
});

test('shows readable review content and keeps frozen identifiers in technical details', async ({
  page,
}) => {
  await page.goto(`/rev-02?id=${S}`);
  await expect(page.getByRole('heading', { name: '内容审核' })).toBeVisible();
  await expect(page.getByText('冻结证据摘录。')).toBeVisible();
  await expect(page.getByText(CV, { exact: true })).toBeHidden();
  await expect(page.getByText(H, { exact: true })).toBeHidden();
  await page.getByText('审核记录技术信息').click();
  await expect(page.getByText('生成方式：DeepSeek · 质量优先')).toBeVisible();
});

test('approves one variant with version and idempotency', async ({ page }) => {
  let request: { body: unknown; headers: Record<string, string> } | undefined;
  await page.route(`**/api/v1/review-snapshots/${S}/approve`, async (route) => {
    request = { body: route.request().postDataJSON(), headers: route.request().headers() };
    await json(route, detail('approved'));
  });
  await page.goto(`/rev-02?id=${S}`);
  await page.getByRole('button', { name: '通过此平台内容' }).click();
  await expect(page.getByText('该平台内容已通过。')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('此平台内容已通过');
  await expect(page.getByText('审核结果已经保存，这份内容可以进入发布准备。')).toBeVisible();
  await expect(page.getByRole('button', { name: '通过此平台内容' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '返回待审核内容' })).toHaveAttribute(
    'href',
    '/rev-01',
  );
  await expect(page.getByRole('link', { name: '安排发布' })).toHaveAttribute(
    'href',
    `/pub-02?variant_id=${V}`,
  );
  expect(request?.body).toEqual({ comment: null, variant_ids: [V] });
  expect(request?.headers['if-match']).toBe('"1"');
  expect(request?.headers['idempotency-key']).toMatch(/^review-approve-/u);
});

test('never reports success when the server detects hash drift', async ({ page }) => {
  await page.route(`**/api/v1/review-snapshots/${S}/reject`, (route) =>
    route.fulfill({ status: 409, contentType: 'application/json', body: '{}' }),
  );
  await page.goto(`/rev-02?id=${S}`);
  await page.getByLabel('意见').fill('证据与内容不一致');
  await page.getByRole('button', { name: '退回修改（请填写原因）' }).click();
  await expect(page.getByText('内容已发生变化，请刷新页面并重新确认后再提交。')).toBeVisible();
  await expect(page.getByText('该平台内容已退回修改。')).toHaveCount(0);
});

test('creates signoff and keeps non-review roles out on mobile', async ({ page }) => {
  let body: unknown;
  await page.route(`**/api/v1/review-snapshots/${S}/request-signoff`, async (route) => {
    body = route.request().postDataJSON();
    await json(route, requirement(), 201);
  });
  await page.goto(`/rev-02?id=${S}`);
  await page.getByLabel('需要谁共同确认').selectOption('tenant_admin');
  await page.getByRole('button', { name: '邀请他人共同确认' }).click();
  await expect(page.getByText('已邀请另一位负责人共同确认。')).toBeVisible();
  expect(body).toEqual({ comment: null, required_role: 'tenant_admin', variant_id: V });
  await page.unroute('**/api/v1/auth/tenants');
  await role(page, 'viewer');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole('heading', { name: '无权查看审核内容' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused();
});

function detail(status: 'in_review' | 'approved' = 'in_review') {
  return {
    actions: [],
    brand_profile: {
      id: '70000000-0000-4000-8000-000000000090',
      profile_json: { tone: 'direct' },
      schema_version: 'brand-profile@1',
      version: 3,
    },
    prompt_version: {
      content_hash: H,
      id: '71000000-0000-4000-8000-000000000090',
      schema_version: 'content-writer-data@1',
      skill_name: 'content-writer',
      version: '1.2.0',
    },
    snapshot: {
      brand_profile_id: '70000000-0000-4000-8000-000000000090',
      created_at: '2026-07-15T01:00:00.000Z',
      created_by: '40000000-0000-4000-8000-000000000090',
      id: S,
      model_key: 'deepseek-pro',
      package_id: '72000000-0000-4000-8000-000000000090',
      platform_rules_hash: H,
      prompt_version_id: '71000000-0000-4000-8000-000000000090',
      quality_rules_hash: H,
      requirements: [],
      snapshot_hash: H,
      status,
      tenant_id: T,
      updated_at: '2026-07-15T01:00:00.000Z',
      variants: [
        {
          citations: [
            {
              ai_citation_id: '80000000-0000-4000-8000-000000000090',
              citation_hash: H,
              created_at: '2026-07-15T01:00:00.000Z',
              id: '81000000-0000-4000-8000-000000000090',
              snapshot_variant_id: SV,
              tenant_id: T,
            },
          ],
          content_hash: H,
          content_version_id: CV,
          created_at: '2026-07-15T01:00:00.000Z',
          id: SV,
          platform_code: 'zhihu',
          platform_rule_version_id: '82000000-0000-4000-8000-000000000090',
          quality_report_id: '83000000-0000-4000-8000-000000000090',
          snapshot_id: S,
          status,
          tenant_id: T,
          variant_id: V,
        },
      ],
      version: status === 'in_review' ? 1 : 2,
    },
    variants: [
      {
        citations: [
          {
            ai_citation_id: '80000000-0000-4000-8000-000000000090',
            chunk_id: '84000000-0000-4000-8000-000000000090',
            claim_key: 'claim-1',
            claim_text: '冻结事实声明',
            quote_hash: H,
            quote_text: '冻结证据摘录。',
          },
        ],
        content_json: { schema_version: 'content-zhihu@1', title: '冻结内容' },
        platform_code: 'zhihu',
        platform_rule: {
          content_hash: H,
          id: '82000000-0000-4000-8000-000000000090',
          rules_json: { title_max: 100 },
          version: '1.0.0',
        },
        quality_report: {
          checker_version: '1.0.0',
          decision: 'pass',
          geo_scores_json: { total: 95 },
          id: '83000000-0000-4000-8000-000000000090',
          issues_json: { issues: [] },
          score: 95,
        },
        schema_version: 'content-zhihu@1',
        snapshot_variant_id: SV,
      },
    ],
  };
}
function requirement() {
  return {
    completed_at: null,
    created_at: '2026-07-15T01:00:00.000Z',
    id: '90000000-0000-4000-8000-000000000090',
    requested_by: '40000000-0000-4000-8000-000000000090',
    required_role: 'tenant_admin',
    required_user_id: null,
    snapshot_id: S,
    status: 'pending',
    tenant_id: T,
    updated_at: '2026-07-15T01:00:00.000Z',
    variant_id: V,
  };
}
async function role(page: Page, roleCode: string) {
  await page.route('**/api/v1/auth/tenants', (route) =>
    json(route, [
      {
        id: T,
        is_active: true,
        last_used_at: null,
        name: '审核企业',
        role_code: roleCode,
        slug: 'review',
      },
    ]),
  );
}
async function json(route: Route, data: unknown, status = 200) {
  await route.fulfill({
    body: JSON.stringify({ data, meta: { request_id: 'rev-02' } }),
    contentType: 'application/json',
    status,
  });
}
