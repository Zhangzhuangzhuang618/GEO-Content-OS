import { expect, test, type Page, type Route } from '@playwright/test';

const TENANT_ID = '10000000-0000-4000-8000-000000000073';
const WORKSPACE_ID = '20000000-0000-4000-8000-000000000073';
const PROJECT_ID = '30000000-0000-4000-8000-000000000073';
const KEYWORD_SET_ID = '60000000-0000-4000-8000-000000000073';
const KEYWORD_ID = '61000000-0000-4000-8000-000000000073';
const BAIJIAHAO_KEYWORD_ID = '62000000-0000-4000-8000-000000000073';
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
  await page.route(`**/api/v1/keyword-sets/${KEYWORD_SET_ID}/keywords?*`, (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [keyword()],
        meta: { next_cursor: null, request_id: 'keywords' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route('**/api/v1/brand-profiles?*', (route) =>
    json(route, [brandProfile('published')]),
  );
  await page.route('**/api/v1/sources?*', (route) =>
    route.fulfill({
      body: JSON.stringify({ data: [], meta: { next_cursor: null, request_id: 'sources' } }),
      contentType: 'application/json',
      status: 200,
    }),
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

test('exposes account, enterprise switching and logout actions in the global header', async ({
  page,
}) => {
  let logoutCalled = false;
  await page.route('**/api/v1/auth/logout', async (route) => {
    logoutCalled = true;
    await route.fulfill({ status: 204 });
  });
  await page.goto(`/dash-01?workspace_id=${WORKSPACE_ID}`);

  await page.getByLabel('打开账号与企业菜单').click();
  await expect(page.getByText('admin@example.com')).toBeVisible();
  await expect(
    page.locator('header details').getByRole('link', { name: '切换企业' }),
  ).toHaveAttribute('href', new RegExp('^/auth-02\\?return_to=', 'u'));
  await expect(page.getByRole('button', { name: '切换账号' })).toBeVisible();
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect.poll(() => logoutCalled).toBe(true);
});

test('persists time, workspace and project filters in the URL', async ({ page }) => {
  await page.goto(`/dash-01?from=2026-07-01&to=2026-07-31&workspace_id=${WORKSPACE_ID}`);
  await expect(page.getByRole('heading', { name: '开始创作' })).toBeVisible();
  await page.getByText('工作概览与筛选').click();
  await page.getByLabel('项目', { exact: true }).selectOption(PROJECT_ID);
  await expect(page).toHaveURL(
    new RegExp(
      `from=2026-07-01.*to=2026-07-31.*workspace_id=${WORKSPACE_ID}.*project_id=${PROJECT_ID}$`,
      'u',
    ),
  );
  await expect(
    page.getByLabel('工作台指标').getByText('内容任务', { exact: true }).locator('..'),
  ).toContainText('2 项');
  await expect(page.getByText('¥123.45')).toBeVisible();
  await expect(page.getByRole('region', { name: '当前创作范围' })).toContainText('示例企业');
  await expect(page.getByRole('link', { name: '切换企业' })).toHaveAttribute('href', '/auth-02');
});

test('creates the first project inline and keeps the user in the content flow', async ({
  page,
}) => {
  let createBody: Record<string, unknown> | null = null;
  await page.route('**/api/v1/projects*', async (route) => {
    if (route.request().method() === 'POST') {
      createBody = route.request().postDataJSON() as Record<string, unknown>;
      await response(route, project(), 201);
      return;
    }
    await json(route, []);
  });

  await page.goto(`/dash-01?workspace_id=${WORKSPACE_ID}`);
  await expect(page.getByRole('heading', { name: '先创建第一个项目' })).toBeVisible();
  await page.getByLabel('项目名称').fill('官网内容运营');
  await page.getByRole('button', { name: '创建项目' }).click();

  await expect(page.getByText('项目已创建，可以继续填写主题并生成内容。')).toBeVisible();
  await expect(page.getByRole('heading', { name: '先创建第一个项目' })).toHaveCount(0);
  await expect(page).toHaveURL(/\/dash-01\?/u);
  await expect(page).toHaveURL(new RegExp(`workspace_id=${WORKSPACE_ID}`, 'u'));
  expect(createBody).toMatchObject({
    name: '官网内容运营',
    owner_id: OWNER_ID,
    workspace_id: WORKSPACE_ID,
  });
});

test('shows only cards and actions allowed by the active role', async ({ page }) => {
  await page.goto(`/dash-01?from=2026-07-01&to=2026-07-31&workspace_id=${WORKSPACE_ID}`);
  await expect(page.getByText('等待审核').first()).toBeVisible();
  await expect(page.getByText('发布任务').first()).toBeVisible();
  await page.getByText('工作概览与筛选').click();
  await expect(page.getByText('已结算成本')).toBeVisible();
  await expect(page.getByRole('link', { name: /等待审核/u }).first()).toHaveAttribute(
    'href',
    '/rev-01',
  );
  await expect(page.getByRole('link', { name: /发布任务/u }).first()).toHaveAttribute(
    'href',
    '/pub-02',
  );

  await mockRole(page, 'viewer');
  await page.reload();
  await expect(page.getByText('需要处理的异常')).toBeVisible();
  await expect(page.getByText('最近内容')).toBeVisible();
  await expect(page.getByText('等待审核')).toHaveCount(0);
  await expect(page.getByText('发布任务')).toHaveCount(0);
  await page.getByText('工作概览与筛选').click();
  await expect(page.getByText('已结算成本')).toHaveCount(0);
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
  await page.getByText('工作概览与筛选').click();
  await expect(
    page.getByLabel('工作台指标').getByText('内容任务', { exact: true }).locator('..'),
  ).toContainText('2 项');
  const costCard = page
    .getByLabel('工作台指标')
    .getByText('已结算成本', { exact: true })
    .locator('..');
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
  await expect(page.getByText('工作概览与筛选')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '移动端主导航' })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: '移动端主导航' }).getByRole('link', {
      name: '内容创作',
    }),
  ).toBeVisible();
});

test('exposes every standalone function page through visible navigation', async ({ page }) => {
  await page.goto(`/dash-01?workspace_id=${WORKSPACE_ID}`);

  const primaryNavigation = page.getByRole('navigation', { name: '主导航' });
  const primaryEntries = [
    ['首页', '/dash-01'],
    ['内容创作', '/cont-03'],
    ['品牌与选题', '/str-01'],
    ['待办审核', '/rev-01'],
    ['发布管理', '/pub-02'],
    ['企业资料', '/know-01'],
    ['数据', '/anl-01'],
    ['设置', '/set-02'],
  ] as const;
  for (const [name, href] of primaryEntries) {
    await expect(primaryNavigation.getByRole('link', { name, exact: true })).toHaveAttribute(
      'href',
      href,
    );
  }

  const sections = [
    {
      label: '内容创作功能',
      path: '/cont-03',
      links: [
        ['内容列表', '/cont-03'],
        ['内容需求', '/cont-01'],
        ['新建内容需求', '/cont-02'],
      ],
    },
    {
      label: '品牌与选题功能',
      path: '/str-01',
      links: [
        ['品牌策略', '/str-01'],
        ['关键词管理', '/str-04'],
        ['选题规划', '/str-03'],
      ],
    },
    {
      label: '审核功能',
      path: '/rev-01',
      links: [['待审核内容', '/rev-01']],
    },
    {
      label: '发布管理功能',
      path: '/pub-02',
      links: [
        ['发布任务', '/pub-02'],
        ['平台账号', '/pub-01'],
      ],
    },
    {
      label: '企业资料功能',
      path: '/know-01',
      links: [
        ['资料列表', '/know-01'],
        ['导入资料', '/know-02'],
        ['事实裁决', '/know-04'],
      ],
    },
    {
      label: '数据功能',
      path: '/anl-01',
      links: [
        ['数据总览', '/anl-01'],
        ['AI 可见度', '/anl-03'],
        ['指标导入', '/anl-02'],
        ['成本中心', '/anl-04'],
      ],
    },
    {
      label: '设置功能',
      path: '/set-02',
      links: [
        ['工作区', '/set-02'],
        ['成员与权限', '/set-01'],
        ['操作日志', '/set-04'],
        ['AI 与平台规则（平台运营）', '/set-03'],
        ['企业管理（平台管理员）', '/plat-01'],
      ],
    },
  ] as const;

  for (const section of sections) {
    await page.goto(section.path);
    const navigation = page.getByRole('navigation', { name: section.label });
    await expect(navigation).toBeVisible();
    for (const [name, href] of section.links) {
      await expect(navigation.getByRole('link', { name, exact: true })).toHaveAttribute(
        'href',
        href,
      );
    }
  }

  await page.goto('/qual-01');
  await expect(
    page.getByRole('navigation', { name: '主导航' }).getByRole('link', {
      name: '内容创作',
    }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByRole('navigation', { name: '内容创作功能' }).getByRole('link', {
      name: '内容列表',
    }),
  ).toHaveAttribute('aria-current', 'page');

  await page.goto('/plat-01');
  await expect(
    page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '设置' }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByRole('navigation', { name: '设置功能' }).getByRole('link', {
      name: '企业管理（平台管理员）',
    }),
  ).toHaveAttribute('aria-current', 'page');

  await page.setViewportSize({ height: 800, width: 375 });
  await page.goto('/anl-01');
  await expect(page.getByRole('navigation', { name: '数据功能' })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: '数据功能' }).getByRole('link', {
      name: '成本中心',
    }),
  ).toBeVisible();
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
    'sohu',
    'lieju',
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
  await page.getByText('选择参考资料和补充要求').click();
  await expect(page.getByText('当前项目没有适用于所选平台的关键词。')).toBeVisible();
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
        intents: ['informational'],
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

test('creates a compatible keyword instead of submitting an official-site keyword to Baijiahao', async ({
  page,
}) => {
  const topic = '广州工厂搬迁如何做到安全高效';
  let briefBody: Record<string, unknown> | undefined;
  let keywordBody: Record<string, unknown> | undefined;
  const baijiahaoKeyword = {
    ...keyword(),
    id: BAIJIAHAO_KEYWORD_ID,
    platform_scope: ['baijiahao'],
    priority: 50,
    term: topic,
  };
  await page.route(`**/api/v1/keyword-sets/${KEYWORD_SET_ID}/keywords`, async (route) => {
    keywordBody = route.request().postDataJSON() as Record<string, unknown>;
    await response(route, [baijiahaoKeyword]);
  });
  await page.route('**/api/v1/briefs', async (route) => {
    briefBody = route.request().postDataJSON() as Record<string, unknown>;
    await response(
      route,
      {
        ...brief(['baijiahao']),
        keyword_ids: [BAIJIAHAO_KEYWORD_ID],
        platform_codes: ['baijiahao'],
        primary_keyword_id: BAIJIAHAO_KEYWORD_ID,
        title: topic,
      },
      201,
    );
  });
  await page.route('**/api/v1/content-packages', (route) => route.fulfill({ status: 503 }));

  await page.goto(`/dash-01?workspace_id=${WORKSPACE_ID}`);
  await page.getByLabel('想创作什么内容？').fill(topic);
  await page.getByRole('checkbox', { name: '百家号' }).check();
  await page.getByRole('checkbox', { name: '官网' }).uncheck();
  await page.getByText('选择参考资料和补充要求').click();

  await expect(page.getByLabel('核心关键词（不选则自动使用）')).not.toContainText('GEO 品牌可见度');
  await expect(page.getByText('当前项目没有适用于所选平台的关键词。')).toBeVisible();
  await page.getByRole('button', { name: '生成内容' }).click();

  await expect.poll(() => briefBody).toBeDefined();
  expect(keywordBody).toEqual({
    keywords: [
      {
        intents: ['informational'],
        platform_scope: ['baijiahao'],
        priority: 50,
        status: 'active',
        synonyms: [],
        term: topic,
      },
    ],
  });
  expect(briefBody).toMatchObject({
    keyword_ids: [BAIJIAHAO_KEYWORD_ID],
    platform_codes: ['baijiahao'],
    primary_keyword_id: BAIJIAHAO_KEYWORD_ID,
  });
});

test('shows the Brief conflict reason and prevents duplicate submissions', async ({ page }) => {
  let briefRequests = 0;
  await page.route('**/api/v1/briefs', async (route) => {
    briefRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await route.fulfill({
      body: JSON.stringify({
        error: {
          code: 'STATE_TRANSITION_INVALID',
          message: '状态转换不允许',
          request_id: 'brief-conflict',
        },
      }),
      contentType: 'application/json',
      status: 409,
    });
  });

  await page.goto(`/dash-01?workspace_id=${WORKSPACE_ID}`);
  await page.getByLabel('想创作什么内容？').fill('重复提交保护测试');
  await page.locator('#create-content form').evaluate((form) => {
    (form as HTMLFormElement).requestSubmit();
    (form as HTMLFormElement).requestSubmit();
  });

  await expect(page.getByRole('status')).toContainText(
    '当前项目、关键词或参考资料与所选平台不匹配',
  );
  expect(briefRequests).toBe(1);
  await expect(page.getByRole('status')).not.toContainText('登录');
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
    created_at: '2026-08-15T00:00:00.000Z',
    id,
    project_id: PROJECT_ID,
    status,
    updated_at: '2026-08-15T01:00:00.000Z',
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
    intents: ['informational'],
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
        automation_run: null,
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
