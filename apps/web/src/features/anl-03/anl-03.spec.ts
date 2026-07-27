import { expect, test, type Page, type Route } from '@playwright/test';

const TENANT = '10000000-0000-4000-8000-000000000096';
const WORKSPACE = '20000000-0000-4000-8000-000000000096';
const OBSERVATION = '30000000-0000-4000-8000-000000000096';
const ASSET = '40000000-0000-4000-8000-000000000096';
const PROJECT = '50000000-0000-4000-8000-000000000096';
const QUERY_SET = '60000000-0000-4000-8000-000000000096';
const RUN = '70000000-0000-4000-8000-000000000096';
const HASH = 'a'.repeat(64);

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    { name: 'geo_csrf', url: 'http://127.0.0.1:34126', value: 'v'.repeat(43) },
  ]);
  await role(page, 'analyst');
  await page.route('**/api/v1/workspaces?*', (route) =>
    json(route, { data: [workspace()], meta: { next_cursor: null, request_id: 'workspace' } }),
  );
  await page.route('**/api/v1/projects?*', (route) =>
    json(route, {
      data: [{ id: PROJECT, name: '广州搬家项目', status: 'active', workspace_id: WORKSPACE }],
      meta: { next_cursor: null, request_id: 'projects' },
    }),
  );
  await page.route('**/api/v1/ai-visibility/query-sets?*', (route) => json(route, response([])));
  await page.route('**/api/v1/visibility-observations/trend?*', (route) =>
    json(route, response([trendPoint()])),
  );
});

test('records screenshot evidence through the visibility API for object storage', async ({
  page,
}) => {
  let request: { body: Record<string, unknown>; key: string | undefined } | null = null;
  await page.route('**/api/v1/visibility-observations', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    request = {
      body: route.request().postDataJSON() as Record<string, unknown>,
      key: route.request().headers()['idempotency-key'],
    };
    await json(route, response(observation(true)), 201);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/anl-03');
  await page.getByText('人工观察与 CSV 补录').click();
  const form = page.getByRole('heading', { name: '录入观察' }).locator('..');
  await form.getByLabel('查询内容').fill('GEO Content OS');
  await form.getByLabel('排名').fill('2');
  await form.getByLabel('被引用').check();
  await form.getByLabel('证据截图').setInputFiles({
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    mimeType: 'image/png',
    name: 'evidence.png',
  });
  await form.getByRole('button', { name: '录入' }).click();
  await expect(page.getByText('截图已保存为对象存储证据')).toBeVisible();
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await expect(page.getByText(ASSET)).toHaveCount(0);
  expect(request).not.toBeNull();
  expect(request!.key).toMatch(/^visibility-create-[0-9a-f-]{36}$/u);
  expect(request!.body['screenshot']).toEqual({
    body_base64: 'iVBORw0KGgo=',
    mime_type: 'image/png',
  });
  await expect(page).toHaveURL(new RegExp(`workspace_id=${WORKSPACE}`, 'u'));
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

test('imports CSV atomically and writes trend filters to the URL', async ({ page }) => {
  let importedRows = 0;
  let importedWorkspace = '';
  let trendUrl = '';
  await page.route('**/api/v1/visibility-observations/import', async (route) => {
    const body = route.request().postDataJSON() as {
      rows?: unknown;
      workspace_id?: unknown;
    };
    importedRows = Array.isArray(body.rows) ? body.rows.length : 0;
    importedWorkspace = typeof body.workspace_id === 'string' ? body.workspace_id : '';
    await json(route, response([observation(false), { ...observation(false), id: ASSET }]), 201);
  });
  await page.unroute('**/api/v1/visibility-observations/trend?*');
  await page.route('**/api/v1/visibility-observations/trend?*', async (route) => {
    trendUrl = route.request().url();
    await json(route, response([trendPoint()]));
  });
  await page.goto('/anl-03');
  await page.getByText('人工观察与 CSV 补录').click();
  await page.getByLabel('CSV 文件').setInputFiles({
    buffer: Buffer.from(
      'query_text,platform_code,rank_position,is_cited,observed_at,notes\nGEO Content OS,zhihu,2,true,2026-07-15T08:00:00.000Z,证据命中\nGEO Content OS,zhihu,,false,2026-07-16T08:00:00.000Z,未命中\n',
    ),
    mimeType: 'text/csv',
    name: 'visibility.csv',
  });
  await expect(page.getByText('CSV 校验通过，共 2 行')).toBeVisible();
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await expect(page.getByText('已导入 2 条观察')).toBeVisible();
  expect(importedWorkspace).toBe(WORKSPACE);
  expect(importedRows).toBe(2);
  const filter = page.getByRole('form', { name: '可见性趋势筛选' });
  await filter.getByLabel('查询内容').fill('GEO Content OS');
  await filter.getByLabel('平台').selectOption('zhihu');
  await filter.getByRole('button', { name: '查看趋势' }).click();
  await expect(page).toHaveURL(/query_text=GEO\+Content\+OS/u);
  expect(trendUrl).toContain('query_text=GEO+Content+OS');
  expect(trendUrl).toContain('platform_code=zhihu');
});

test('denies a viewer before visibility data requests', async ({ page }) => {
  let requests = 0;
  await page.unroute('**/api/v1/auth/tenants');
  await role(page, 'viewer');
  await page.route('**/api/v1/visibility-observations/**', async (route) => {
    requests++;
    await route.abort();
  });
  await page.goto('/anl-03');
  await page.getByText('人工观察与 CSV 补录').click();
  await expect(page.getByRole('heading', { name: '无权访问可见性观察' })).toBeVisible();
  expect(requests).toBe(0);
});

test('runs a human-readable AI visibility check and exposes raw answers and content gaps', async ({
  page,
}) => {
  await page.unroute('**/api/v1/ai-visibility/query-sets?*');
  await page.route('**/api/v1/ai-visibility/query-sets*', async (route) => {
    if (route.request().method() === 'GET') return json(route, response([]));
    return json(route, response(querySet()), 201);
  });
  await page.route('**/api/v1/ai-visibility/runs', (route) =>
    json(route, response([runSummary('queued')]), 201),
  );
  await page.route(`**/api/v1/ai-visibility/runs/${RUN}?*`, (route) =>
    json(route, response(runDetail())),
  );
  await page.route('**/api/v1/ai-visibility/runs?*', (route) =>
    json(route, response([runSummary('succeeded')])),
  );

  await page.goto('/anl-03');
  await page.getByLabel('品牌名称').fill('志远搬家');
  await page.getByLabel('所属行业').fill('搬家服务');
  await page.getByLabel('主要市场').fill('广州');
  await page.getByLabel('真实竞品 至少 2 个，逗号或换行分隔').fill('竞品甲，竞品乙');
  await page.getByRole('button', { name: '生成 30 个测试问题' }).click();
  await expect(page.getByRole('heading', { name: '确认基准问题' })).toBeVisible();
  await expect(page.getByText('品牌认知 · 1 问')).toBeVisible();
  await page.getByRole('button', { name: '开始 30 问体检' }).click();
  await expect(page.getByRole('heading', { name: '体检结果' })).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText('75', { exact: true })).toBeVisible();
  await expect(page.getByText('请推荐广州搬家公司')).toBeVisible();
  await page.getByText('逐题原始回答').scrollIntoViewIfNeeded();
  await page.locator('summary').filter({ hasText: '1. 你了解志远搬家吗？' }).click();
  await expect(page.getByText('志远搬家是一家正规、可靠的搬家公司。')).toBeVisible();
});

function observation(withAsset: boolean) {
  return {
    created_at: '2026-07-16T08:01:00.000Z',
    evidence_asset_id: withAsset ? ASSET : null,
    id: OBSERVATION,
    is_cited: true,
    notes: null,
    observed_at: '2026-07-16T08:00:00.000Z',
    platform_code: 'zhihu',
    query_hash: HASH,
    query_text: 'GEO Content OS',
    rank_position: 2,
    tenant_id: TENANT,
    workspace_id: WORKSPACE,
  };
}
function trendPoint() {
  return {
    average_rank: 2.5,
    best_rank: 2,
    citation_count: 1,
    citation_rate: 0.5,
    day: '2026-07-16',
    observation_count: 2,
    platform_code: 'zhihu',
    query_hash: HASH,
    query_text: 'GEO Content OS',
  };
}
function workspace() {
  return {
    created_at: '2026-07-16T00:00:00.000Z',
    id: WORKSPACE,
    name: '可见性工作区',
    settings: { default_platform_codes: ['zhihu'], schema_version: 'workspace-settings@1' },
    slug: 'visibility',
    status: 'active',
    tenant_id: TENANT,
    timezone: 'Asia/Shanghai',
    updated_at: '2026-07-16T00:00:00.000Z',
    version: 1,
  };
}
function querySet() {
  const intents = [
    'brand_recognition',
    'exploration',
    'recommendation',
    'comparison',
    'education',
    'procurement',
  ] as const;
  return {
    brand_aliases: ['广州志远搬家'],
    brand_name: '志远搬家',
    competitor_names: ['竞品甲', '竞品乙'],
    created_at: '2026-07-26T08:00:00.000Z',
    created_by: TENANT,
    id: QUERY_SET,
    industry: '搬家服务',
    locale: 'zh-CN',
    market: '广州',
    methodology_version: 'ai-visibility@2',
    name: '广州搬家 AI 可见度基准',
    positioning: null,
    project_id: PROJECT,
    queries: intents.map((intent, index) => ({
      commercial_value: index >= 2 ? 'high' : 'medium',
      created_at: '2026-07-26T08:00:00.000Z',
      id: `80000000-0000-4000-8000-00000000009${index}`,
      intent_code: intent,
      query_hash: String(index + 1).repeat(64),
      query_key: `q00${index + 1}`,
      query_text: index === 0 ? '你了解志远搬家吗？' : `${intent} 测试问题`,
      sort_order: index + 1,
    })),
    query_count: 30,
    revision: 1,
    series_id: '61000000-0000-4000-8000-000000000096',
    status: 'active',
    updated_at: '2026-07-26T08:00:00.000Z',
    workspace_id: WORKSPACE,
  };
}
function runSummary(status: 'queued' | 'succeeded') {
  const complete = status === 'succeeded';
  return {
    baseline_run_id: null,
    completed_count: complete ? 30 : 0,
    competitors: complete
      ? [{ average_rank: null, mention_count: 18, mention_rate: 0.6, name: '竞品甲' }]
      : [],
    created_at: '2026-07-26T08:01:00.000Z',
    engine_code: 'deepseek',
    error_json: null,
    failed_count: 0,
    finished_at: complete ? '2026-07-26T08:02:00.000Z' : null,
    id: RUN,
    methodology_version: 'ai-visibility@2',
    metrics: complete
      ? {
          answered_count: 30,
          average_rank: 2,
          mention_rate: 0.5,
          misidentified_count: 0,
          natural_answered_count: 20,
          positive_sentiment_rate: 0.8,
          rank_score: 0.75,
          ranked_count: 4,
          recognized_count: 4,
          recognition_rate: 0.8,
          recommendation_rate: 0.4,
          score: 75,
          total_count: 30,
        }
      : null,
    model_key: 'deepseek-v4-flash',
    opportunities: complete
      ? [
          {
            commercial_value: 'high',
            competitors_mentioned: ['竞品甲'],
            intent_code: 'recommendation',
            query_id: '80000000-0000-4000-8000-000000000092',
            query_key: 'q003',
            query_text: '请推荐广州搬家公司',
          },
        ]
      : [],
    project_id: PROJECT,
    query_count: 30,
    query_set_id: QUERY_SET,
    requested_by: TENANT,
    retrieval_mode: 'model_only',
    score: complete ? 75 : null,
    scoring_version: 'ai-visibility-score@2',
    sources: [],
    started_at: complete ? '2026-07-26T08:01:01.000Z' : null,
    status,
    updated_at: complete ? '2026-07-26T08:02:00.000Z' : '2026-07-26T08:01:00.000Z',
    version: complete ? 3 : 1,
    workspace_id: WORKSPACE,
  };
}
function runDetail() {
  return {
    ...runSummary('succeeded'),
    query_set: querySet(),
    responses: [
      {
        answer_text: '志远搬家是一家正规、可靠的搬家公司。',
        citations: [],
        competitors_mentioned: [],
        error_json: null,
        id: '90000000-0000-4000-8000-000000000096',
        observed_at: '2026-07-26T08:01:30.000Z',
        provider_request_id: 'deepseek-request-96',
        query: querySet().queries[0],
        recommended: true,
        recognition_status: 'recognized',
        response_hash: HASH,
        sentiment: 'positive',
        target_mentioned: true,
        target_rank: 1,
        usage: null,
      },
    ],
  };
}
async function role(page: Page, code: string) {
  await page.route('**/api/v1/auth/tenants', (route) =>
    json(route, {
      data: [
        {
          id: TENANT,
          is_active: true,
          last_used_at: null,
          name: '分析企业',
          role_code: code,
          slug: 'analytics',
        },
      ],
      meta: { request_id: 'role' },
    }),
  );
}
function response(data: unknown) {
  return { data, meta: { request_id: 'visibility' } };
}
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}
