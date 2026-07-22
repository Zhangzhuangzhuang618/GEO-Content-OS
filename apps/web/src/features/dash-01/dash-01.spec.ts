import { expect, test, type Page, type Route } from '@playwright/test';

const TENANT_ID = '10000000-0000-4000-8000-000000000073';
const WORKSPACE_ID = '20000000-0000-4000-8000-000000000073';
const PROJECT_ID = '30000000-0000-4000-8000-000000000073';
const KEYWORD_SET_ID = '60000000-0000-4000-8000-000000000073';
const KEYWORD_ID = '61000000-0000-4000-8000-000000000073';
const BRIEF_ID = '70000000-0000-4000-8000-000000000073';
const PACKAGE_ID = '80000000-0000-4000-8000-000000000073';
const OWNER_ID = '90000000-0000-4000-8000-000000000073';
const RUN_ID = 'a0000000-0000-4000-8000-000000000073';
const BRAND_ID = 'd0000000-0000-4000-8000-000000000073';
const HASH = 'a'.repeat(64);

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    { name: 'geo_csrf', url: 'http://127.0.0.1:34103', value: 'x'.repeat(43) },
  ]);
  await mockRole(page, 'tenant_admin');
  await page.route('**/api/v1/auth/session', (route) =>
    response(route, {
      active_tenant_id: TENANT_ID,
      expires_at: '2026-07-19T00:00:00.000Z',
      user: {
        display_name: '张管理员',
        email: 'admin@example.com',
        id: OWNER_ID,
      },
    }),
  );
  await page.route('**/api/v1/workspaces?*', (route) => json(route, [workspace()]));
  await page.route('**/api/v1/projects?*', (route) => json(route, [project()]));
  await page.route('**/api/v1/keyword-sets?*', (route) => json(route, [keywordSet()]));
  await page.route(`**/api/v1/keyword-sets/${KEYWORD_SET_ID}`, (route) =>
    response(route, { ...keywordSet(), keywords: [keyword()] }),
  );
  await page.route('**/api/v1/brand-profiles?*', (route) =>
    json(route, [brandProfile('published')]),
  );
  await page.route('**/api/v1/content-packages?*', (route) =>
    json(route, [
      contentPackage('in_review', '40000000-0000-4000-8000-000000000073'),
      contentPackage('publish_failed', '50000000-0000-4000-8000-000000000073'),
    ]),
  );
  await page.route('**/api/v1/analytics/costs?*', (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: {
          breakdown: [],
          package_totals: [],
          settled_only: true,
          totals: [{ cost_cents: 12345, currency: 'CNY', entry_count: 2 }],
        },
        meta: { request_id: 'costs' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
});

test('exposes account, enterprise switching and logout actions in the global header', async ({ page }) => {
  let logoutCalled = false;
  await page.route('**/api/v1/auth/logout', async (route) => {
    logoutCalled = true;
    await route.fulfill({ status: 204 });
  });
  await page.goto(`/dash-01?workspace_id=${WORKSPACE_ID}`);

  await page.locator('header details summary').click();
  await expect(page.getByText('admin@example.com')).toBeVisible();
  await expect(page.locator('header details').getByRole('link', { name: '切换企业' })).toHaveAttribute(
    'href',
    new RegExp('^/auth-02\\?return_to=', 'u'),
  );
  await expect(page.getByRole('button', { name: '切换账号' })).toBeVisible();
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect.poll(() => logoutCalled).toBe(true);
});

test('persists time, workspace and project filters in the URL', async ({ page }) => {
  await page.goto(`/dash-01?from=2026-07-01&to=2026-07-31&workspace_id=${WORKSPACE_ID}`);
  await expect(page.getByRole('heading', { name: '开始创作' })).toBeVisible();
  await page.getByLabel('项目', { exact: true }).selectOption(PROJECT_ID);
  await expect(page).toHaveURL(
    new RegExp(
      `from=2026-07-01.*to=2026-07-31.*workspace_id=${WORKSPACE_ID}.*project_id=${PROJECT_ID}$`,
      'u',
    ),
  );
  await expect(page.getByText('2 个内容任务')).toBeVisible();
  await expect(page.getByText('¥123.45')).toBeVisible();
  await expect(page.getByRole('region', { name: '当前企业' })).toContainText('示例企业');
  await expect(page.getByRole('link', { name: '切换企业' })).toHaveAttribute('href', '/auth-02');
});

test('shows only cards and actions allowed by the active role', async ({ page }) => {
  await page.goto(`/dash-01?from=2026-07-01&to=2026-07-31&workspace_id=${WORKSPACE_ID}`);
  await expect(page.getByText('审核待办')).toBeVisible();
  await expect(page.getByText('发布待办')).toBeVisible();
  await expect(page.getByText('已结算成本')).toBeVisible();
  await expect(page.getByRole('link', { name: '进入审核' })).toBeVisible();
  await expect(page.getByRole('link', { name: '进入发布' })).toBeVisible();

  await mockRole(page, 'viewer');
  await page.reload();
  await expect(page.getByText('内容产能')).toBeVisible();
  await expect(page.getByText('失败任务').first()).toBeVisible();
  await expect(page.getByText('审核待办')).toHaveCount(0);
  await expect(page.getByText('发布待办')).toHaveCount(0);
  await expect(page.getByText('已结算成本')).toHaveCount(0);
  await expect(page.getByRole('link', { name: '进入审核' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '进入发布' })).toHaveCount(0);
});

test('renders permission and empty states without leaking dashboard cards', async ({ page }) => {
  await page.route('**/api/v1/auth/tenants', (route) => route.fulfill({ status: 403 }));
  await page.goto('/dash-01');
  await expect(page.getByRole('status')).toContainText('无权查看当前工作台');
  await expect(page.getByText('已结算成本')).toHaveCount(0);

  await mockRole(page, 'viewer');
  await page.route('**/api/v1/workspaces?*', (route) => json(route, []));
  await page.reload();
  await expect(page.getByRole('status')).toContainText('暂无可用工作区');
});

test('keeps successful dashboard sections usable when cost loading fails and retries locally', async ({
  page,
}) => {
  let attempts = 0;
  await page.unroute('**/api/v1/analytics/costs?*');
  await page.route('**/api/v1/analytics/costs?*', async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({ status: 503 });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({
        data: {
          breakdown: [],
          package_totals: [],
          settled_only: true,
          totals: [{ cost_cents: 12345, currency: 'CNY', entry_count: 2 }],
        },
        meta: { request_id: 'cost-retry' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto(`/dash-01?workspace_id=${WORKSPACE_ID}`);
  await expect(page.getByText('2 个内容任务')).toBeVisible();
  const costCard = page.getByText('已结算成本').locator('..');
  await expect(costCard).toContainText('暂时无法获取');
  await costCard.getByRole('button', { name: '重新加载' }).click();
  await expect(costCard).toContainText('¥123.45');
  await expect(page.getByText('工作台暂时不可用')).toHaveCount(0);
});

test('returns an expired session to login and preserves the dashboard URL', async ({ page }) => {
  await page.unroute('**/api/v1/auth/tenants');
  await page.route('**/api/v1/auth/tenants', (route) =>
    route.fulfill({
      body: JSON.stringify({ error: { code: 'AUTH_REQUIRED' } }),
      contentType: 'application/json',
      status: 401,
    }),
  );

  await page.goto(`/dash-01?workspace_id=${WORKSPACE_ID}`);

  await expect(page).toHaveURL(
    new RegExp(
      `/auth-01\\?reason=session_expired&return_to=%2Fdash-01%3Fworkspace_id%3D${WORKSPACE_ID}$`,
      'u',
    ),
  );
});

test('remains usable at mobile width with a keyboard focus entry', async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 375 });
  await page.goto(`/dash-01?from=2026-07-01&to=2026-07-31&workspace_id=${WORKSPACE_ID}`);
  await expect(page.getByRole('heading', { name: '开始创作' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused();
  await expect(page.getByLabel('工作台筛选')).toBeVisible();
});

test('creates and starts all-platform content from one human-friendly form', async ({ page }) => {
  let briefBody: Record<string, unknown> | undefined;
  let generationBody: Record<string, unknown> | undefined;
  let keywordSetBody: Record<string, unknown> | undefined;
  let keywordBody: Record<string, unknown> | undefined;
  let brandBody: Record<string, unknown> | undefined;
  const platforms = [
    'official_site',
    'baijiahao',
    'toutiao',
    'zhihu',
    'xiaohongshu',
    'wechat_mp',
    'douyin',
  ];

  await page.unroute('**/api/v1/keyword-sets?*');
  await page.route('**/api/v1/keyword-sets?*', (route) => json(route, []));
  await page.route('**/api/v1/keyword-sets', async (route) => {
    keywordSetBody = route.request().postDataJSON() as Record<string, unknown>;
    await response(route, keywordSet(), 201);
  });
  await page.route(`**/api/v1/keyword-sets/${KEYWORD_SET_ID}/keywords`, async (route) => {
    keywordBody = route.request().postDataJSON() as Record<string, unknown>;
    await response(route, [keyword()]);
  });
  await page.unroute('**/api/v1/brand-profiles?*');
  await page.route('**/api/v1/brand-profiles?*', (route) => json(route, []));
  await page.route('**/api/v1/brand-profiles', async (route) => {
    brandBody = route.request().postDataJSON() as Record<string, unknown>;
    await response(route, brandProfile('draft'), 201);
  });
  await page.route(`**/api/v1/brand-profiles/${BRAND_ID}/publish`, (route) =>
    response(route, brandProfile('published')),
  );
  await page.route('**/api/v1/briefs', async (route) => {
    briefBody = route.request().postDataJSON() as Record<string, unknown>;
    await response(route, brief(platforms), 201);
  });
  await page.route('**/api/v1/content-packages', (route) =>
    response(route, contentPackageDetail(platforms).package, 201),
  );
  await mockQuickCreateDetail(page, platforms);
  await page.route(`**/api/v1/content-packages/${PACKAGE_ID}/generate`, async (route) => {
    generationBody = route.request().postDataJSON() as Record<string, unknown>;
    await response(route, generationRun(), 202);
  });

  await page.goto(`/dash-01?workspace_id=${WORKSPACE_ID}`);
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await expect(page.getByText('系统会自动使用你填写的主题创建关键词')).toBeVisible();
  await expect(page.getByText('系统会建立一份基础策略')).toBeVisible();
  await page.getByLabel('想创作什么内容？').fill('企业如何通过 GEO 提升品牌可见度');
  await page.getByRole('checkbox', { name: '全部平台' }).check();
  await page.getByRole('button', { name: '生成内容' }).click();

  await expect(page).toHaveURL(new RegExp(`/cont-04\\?id=${PACKAGE_ID}&created=1$`, 'u'));
  expect(briefBody).toMatchObject({
    audience: '对该主题感兴趣的潜在读者与客户',
    keyword_ids: [KEYWORD_ID],
    platform_codes: platforms,
    primary_keyword_id: KEYWORD_ID,
    project_id: PROJECT_ID,
    title: '企业如何通过 GEO 提升品牌可见度',
    workspace_id: WORKSPACE_ID,
  });
  expect(keywordSetBody).toEqual({ name: '快速创作关键词', project_id: PROJECT_ID });
  expect(keywordBody).toEqual({
    keywords: [
      {
        intent: 'informational',
        platform_scope: platforms,
        priority: 50,
        status: 'active',
        synonyms: [],
        term: '企业如何通过 GEO 提升品牌可见度',
      },
    ],
  });
  expect(brandBody).toMatchObject({
    profile: {
      audience: ['对该主题感兴趣的潜在读者与客户'],
      tone: '专业、清晰、克制，避免夸张和无法验证的承诺',
    },
    schema_version: 'brand-profile@1',
    workspace_id: WORKSPACE_ID,
  });
  expect(generationBody).toEqual({
    locked_block_keys: [],
    model_policy: 'balanced',
    platform_codes: platforms,
  });
});

test('keeps the created task and retries when generation cannot start', async ({ page }) => {
  const platforms = ['official_site'];
  let generationAttempts = 0;
  await page.route('**/api/v1/briefs', (route) => response(route, brief(platforms), 201));
  await page.route('**/api/v1/content-packages', (route) =>
    response(route, contentPackageDetail(platforms).package, 201),
  );
  await mockQuickCreateDetail(page, platforms);
  await page.route(`**/api/v1/content-packages/${PACKAGE_ID}/generate`, async (route) => {
    generationAttempts += 1;
    if (generationAttempts === 1) {
      await route.fulfill({ status: 503 });
      return;
    }
    await response(route, generationRun(), 202);
  });

  await page.goto(`/dash-01?workspace_id=${WORKSPACE_ID}`);
  await page.getByLabel('想创作什么内容？').fill('GEO 内容恢复测试');
  await page.getByRole('button', { name: '生成内容' }).click();

  await expect(page.getByRole('status')).toContainText('内容任务已创建，但生成暂未启动');
  await expect(page.getByRole('link', { name: '查看内容任务' })).toHaveAttribute(
    'href',
    `/cont-04?id=${PACKAGE_ID}`,
  );
  await page.getByRole('button', { name: '继续重试' }).click();
  await expect(page).toHaveURL(new RegExp(`/cont-04\\?id=${PACKAGE_ID}&created=1$`, 'u'));
  expect(generationAttempts).toBe(2);
});

async function mockRole(page: Page, role: string) {
  await page.route('**/api/v1/auth/tenants', (route) =>
    json(route, [
      {
        id: TENANT_ID,
        is_active: true,
        last_used_at: null,
        name: '示例企业',
        role_code: role,
        slug: 'demo',
      },
    ]),
  );
}

function workspace() {
  return {
    created_at: '2026-07-01T00:00:00.000Z',
    id: WORKSPACE_ID,
    name: '主工作区',
    settings: {
      default_platform_codes: ['official_site'],
      schema_version: 'workspace-settings@1',
    },
    slug: 'main',
    status: 'active',
    tenant_id: TENANT_ID,
    timezone: 'Asia/Shanghai',
    updated_at: '2026-07-01T00:00:00.000Z',
    version: 1,
  };
}

function project() {
  return { id: PROJECT_ID, name: 'GEO 项目', status: 'active', workspace_id: WORKSPACE_ID };
}

function contentPackage(status: 'in_review' | 'publish_failed', id: string) {
  return {
    created_at: '2026-07-15T00:00:00.000Z',
    id,
    project_id: PROJECT_ID,
    status,
    updated_at: '2026-07-15T01:00:00.000Z',
    workspace_id: WORKSPACE_ID,
  };
}

function keywordSet() {
  return {
    created_at: '2026-07-01T00:00:00.000Z',
    id: KEYWORD_SET_ID,
    name: '核心关键词',
    project_id: PROJECT_ID,
    status: 'active',
    tenant_id: TENANT_ID,
    updated_at: '2026-07-01T00:00:00.000Z',
  };
}

function keyword() {
  return {
    created_at: '2026-07-01T00:00:00.000Z',
    id: KEYWORD_ID,
    intent: 'informational',
    keyword_set_id: KEYWORD_SET_ID,
    platform_scope: ['official_site'],
    priority: 100,
    status: 'active',
    synonyms: [],
    tenant_id: TENANT_ID,
    term: 'GEO 品牌可见度',
    updated_at: '2026-07-01T00:00:00.000Z',
  };
}

function brandProfile(status: 'draft' | 'published') {
  return {
    created_at: '2026-07-17T00:00:00.000Z',
    created_by: OWNER_ID,
    id: BRAND_ID,
    profile: {
      audience: ['对该主题感兴趣的潜在读者与客户'],
      banned: ['不得虚构事实、数据、案例或客户评价'],
      compliance: ['事实性陈述必须可验证；不确定信息需要明确标注'],
      cta: null,
      differentiators: [],
      positioning: '主工作区围绕GEO 项目提供专业、清晰、可信的信息与服务。',
      tone: '专业、清晰、克制，避免夸张和无法验证的承诺',
    },
    published_at: status === 'published' ? '2026-07-17T00:01:00.000Z' : null,
    schema_version: 'brand-profile@1',
    status,
    tenant_id: TENANT_ID,
    version: 1,
    workspace_id: WORKSPACE_ID,
  };
}

function brief(platforms: readonly string[]) {
  return {
    audience: '对该主题感兴趣的潜在读者与客户',
    constraints: {
      additional_instructions: null,
      cta: null,
      schema_version: 'brief-constraints@1',
    },
    created_at: '2026-07-17T00:00:00.000Z',
    created_by: OWNER_ID,
    due_at: null,
    id: BRIEF_ID,
    keyword_ids: [KEYWORD_ID],
    objective: 'awareness',
    platform_codes: platforms,
    primary_keyword_id: KEYWORD_ID,
    project_id: PROJECT_ID,
    source_ids: [],
    source_topic_candidate_id: null,
    tenant_id: TENANT_ID,
    title: '企业如何通过 GEO 提升品牌可见度',
    updated_at: '2026-07-17T00:00:00.000Z',
    version: 1,
    workspace_id: WORKSPACE_ID,
  };
}

async function mockQuickCreateDetail(page: Page, platforms: readonly string[]) {
  const detail = contentPackageDetail(platforms);
  await page.route(`**/api/v1/content-packages/${PACKAGE_ID}`, (route) => response(route, detail));
  for (const variant of detail.variants) {
    await page.route(`**/api/v1/content-variants/${variant.id}`, (route) =>
      response(route, {
        citations: [],
        current_content: null,
        locks: [],
        quality_report: null,
        variant,
        versions: [],
      }),
    );
  }
}

function contentPackageDetail(platforms: readonly string[]) {
  return {
    generation_runs: [],
    master_content: null,
    package: {
      brief_id: BRIEF_ID,
      created_at: '2026-07-17T00:00:00.000Z',
      created_by: OWNER_ID,
      id: PACKAGE_ID,
      master_content_version_id: null,
      project_id: PROJECT_ID,
      status: 'draft',
      tenant_id: TENANT_ID,
      updated_at: '2026-07-17T00:00:00.000Z',
      version: 1,
      workspace_id: WORKSPACE_ID,
    },
    variants: platforms.map((platform, index) => ({
      created_at: '2026-07-17T00:00:00.000Z',
      current_content_version_id: null,
      id: `b${index}000000-0000-4000-8000-000000000073`,
      is_required: true,
      package_id: PACKAGE_ID,
      platform_code: platform,
      quality_score: null,
      status: 'draft',
      tenant_id: TENANT_ID,
      updated_at: '2026-07-17T00:00:00.000Z',
      version: 1,
    })),
  };
}

function generationRun() {
  return {
    created_at: '2026-07-17T00:00:00.000Z',
    error: null,
    finished_at: null,
    id: RUN_ID,
    input_hash: HASH,
    model_key: 'flash',
    package_id: PACKAGE_ID,
    project_id: PROJECT_ID,
    prompt_version_id: 'c0000000-0000-4000-8000-000000000073',
    request_id: 'quick-create',
    skill_name: 'content-writer',
    skill_version: '1.0.0',
    started_at: null,
    status: 'queued',
    tenant_id: TENANT_ID,
    updated_at: '2026-07-17T00:00:00.000Z',
    variant_id: null,
    version: 1,
    workspace_id: WORKSPACE_ID,
  };
}

async function json(route: Parameters<Parameters<Page['route']>[1]>[0], data: unknown) {
  await route.fulfill({
    body: JSON.stringify({ data, meta: { next_cursor: null, request_id: 'dash' } }),
    contentType: 'application/json',
    status: 200,
  });
}

async function response(route: Route, data: unknown, status = 200) {
  await route.fulfill({
    body: JSON.stringify({ data, meta: { request_id: 'quick-create' } }),
    contentType: 'application/json',
    status,
  });
}
