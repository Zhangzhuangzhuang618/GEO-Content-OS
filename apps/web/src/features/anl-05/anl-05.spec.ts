import { expect, test, type Page, type Route } from '@playwright/test';

const TENANT = '10000000-0000-4000-8000-000000000105';
const WORKSPACE = '20000000-0000-4000-8000-000000000105';
const PROJECT = '30000000-0000-4000-8000-000000000105';
const BINDING = '40000000-0000-4000-8000-000000000105';
const REMOTE_BINDING = '50000000-0000-4000-8000-000000000105';
const SCOPE = '60000000-0000-4000-8000-000000000105';
const QUERY_SET = '70000000-0000-4000-8000-000000000105';
const SYNC = '80000000-0000-4000-8000-000000000105';
const SNAPSHOT = '90000000-0000-4000-8000-000000000105';
const NOW = '2026-08-23T08:00:00.000Z';

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    { name: 'geo_csrf', url: 'http://127.0.0.1:34130', value: 'w'.repeat(43) },
  ]);
  await role(page, 'tenant_owner');
  await page.route('**/api/v1/workspaces?*', (route) =>
    json(route, { data: [workspace()], meta: { next_cursor: null, request_id: 'workspace' } }),
  );
  await page.route('**/api/v1/projects?*', (route) =>
    json(route, {
      data: [{ id: PROJECT, name: '广州搬家项目', status: 'active', workspace_id: WORKSPACE }],
      meta: { next_cursor: null, request_id: 'project' },
    }),
  );
});

test('submits an explicit project binding request with CSRF and idempotency protection', async ({
  page,
}) => {
  let requestBody: Record<string, unknown> | null = null;
  let requestHeaders: Record<string, string> | null = null;
  await statusRoute(page, status(null));
  await page.route('**/api/v1/integrations/wentian/bindings', async (route) => {
    requestBody = route.request().postDataJSON() as Record<string, unknown>;
    requestHeaders = route.request().headers();
    await json(route, response(binding('pending_wentian', null)), 201);
  });

  await page.goto('/anl-05');
  await expect(page.getByRole('heading', { name: '尚未连接' })).toBeVisible();
  await page.getByRole('button', { name: '申请连接' }).click();
  await expect(page.getByRole('heading', { name: '等待问天确认' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '等待问天确认' }).locator('..')).toContainText(
    '问天管理端选择对应项目',
  );
  expect(requestBody).toEqual({ project_id: PROJECT, workspace_id: WORKSPACE });
  expect(requestHeaders?.['x-csrf-token']).toBe('w'.repeat(43));
  expect(requestHeaders?.['idempotency-key']).toMatch(/^wentian-binding-[0-9a-f-]{36}$/u);
});

test('refreshes an approved binding and syncs one explicitly selected immutable query set', async ({
  page,
}) => {
  await statusRoute(page, status(binding('pending_wentian', null)));
  await page.route(`**/api/v1/integrations/wentian/bindings/${BINDING}/refresh`, (route) =>
    json(route, response(binding('active', SCOPE))),
  );
  await page.route('**/api/v1/ai-visibility/query-sets?*', (route) =>
    json(route, response([querySet()])),
  );
  let syncBody: Record<string, unknown> | null = null;
  await page.route('**/api/v1/integrations/wentian/query-set-syncs', async (route) => {
    syncBody = route.request().postDataJSON() as Record<string, unknown>;
    await json(route, response(sync()), 201);
  });

  await page.goto('/anl-05');
  await page.getByRole('button', { name: '刷新状态' }).click();
  await expect(page.getByRole('heading', { name: '已连接' })).toBeVisible();
  await expect(page.getByRole('button', { name: '进入问天' })).toBeVisible();
  await expect(page.getByLabel('选择问题集')).toHaveValue(QUERY_SET);
  await page.getByRole('button', { name: '同步到问天' }).click();
  await expect(page.getByText('不可变快照同步到问天')).toBeVisible();
  expect(syncBody).toEqual({
    project_id: PROJECT,
    query_set_id: QUERY_SET,
    workspace_id: WORKSPACE,
  });
});

test('lets a viewer enter an active binding but hides administrator mutations', async ({
  page,
}) => {
  await page.unroute('**/api/v1/auth/tenants');
  await role(page, 'viewer');
  await statusRoute(page, status(binding('active', SCOPE)));
  await page.route('**/api/v1/ai-visibility/query-sets?*', (route) =>
    json(route, response([querySet()])),
  );

  await page.goto('/anl-05');
  await expect(page.getByRole('button', { name: '进入问天' })).toBeVisible();
  await expect(page.getByRole('button', { name: '同步到问天' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '断开连接' })).toHaveCount(0);
  await expect(page.getByText('连接、同步和断开由企业管理员')).toBeVisible();
});

test('keeps the rest of GEO usable when the connector is not configured', async ({ page }) => {
  await statusRoute(page, {
    binding: null,
    configuration_status: 'not_configured',
    contract_version: 'wentian-geo-connector@1',
    latest_sync: null,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/anl-05');
  await expect(page.getByRole('heading', { name: '问天连接器尚未配置' })).toBeVisible();
  await expect(page.getByRole('link', { name: '数据总览' })).toBeVisible();
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

function statusRoute(
  page: Page,
  data:
    | ReturnType<typeof status>
    | {
        binding: null;
        configuration_status: 'not_configured';
        contract_version: 'wentian-geo-connector@1';
        latest_sync: null;
      },
) {
  return page.route('**/api/v1/integrations/wentian/status?*', (route) =>
    json(route, response(data)),
  );
}

function status(currentBinding: ReturnType<typeof binding> | null) {
  return {
    binding: currentBinding,
    configuration_status: 'configured' as const,
    contract_version: 'wentian-geo-connector@1' as const,
    latest_sync: null,
  };
}

function binding(statusValue: 'active' | 'pending_wentian', scopeId: string | null) {
  return {
    decision_reason: null,
    geo_project_ref: PROJECT,
    id: BINDING,
    requested_at: NOW,
    status: statusValue,
    updated_at: NOW,
    version: statusValue === 'active' ? 2 : 1,
    wentian_binding_id: REMOTE_BINDING,
    wentian_scope_id: scopeId,
  };
}

function sync() {
  return {
    id: SYNC,
    query_count: 1,
    query_set_id: QUERY_SET,
    query_set_revision: 1,
    snapshot_hash: 'a'.repeat(64),
    synced_at: NOW,
    wentian_snapshot_id: SNAPSHOT,
  };
}

function querySet() {
  return {
    brand_aliases: ['广州志远搬家'],
    brand_name: '志远搬家',
    competitor_names: ['竞品甲', '竞品乙'],
    created_at: NOW,
    created_by: TENANT,
    id: QUERY_SET,
    industry: '搬家服务',
    locale: 'zh-CN',
    market: '广州',
    methodology_version: 'ai-visibility-query-set@1',
    name: '广州搬家公司问题集',
    positioning: null,
    project_id: PROJECT,
    queries: [
      {
        commercial_value: 'high',
        created_at: NOW,
        id: SYNC,
        intent_code: 'recommendation',
        query_hash: 'b'.repeat(64),
        query_key: 'recommendation-01',
        query_text: '广州搬家公司哪家好？',
        sort_order: 1,
      },
    ],
    query_count: 1,
    revision: 1,
    series_id: SNAPSHOT,
    status: 'active',
    updated_at: NOW,
    workspace_id: WORKSPACE,
  };
}

function workspace() {
  return {
    created_at: NOW,
    id: WORKSPACE,
    name: '内容工作区',
    settings: { default_platform_codes: ['official_site'], schema_version: 'workspace-settings@1' },
    slug: 'content',
    status: 'active',
    tenant_id: TENANT,
    timezone: 'Asia/Shanghai',
    updated_at: NOW,
    version: 1,
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
          name: '测试企业',
          role_code: code,
          slug: 'test-tenant',
        },
      ],
      meta: { request_id: 'role' },
    }),
  );
}

function response(data: unknown) {
  return { data, meta: { request_id: 'test' } };
}

async function json(route: Route, body: unknown, statusCode = 200) {
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: 'application/json',
    status: statusCode,
  });
}
