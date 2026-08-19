import { expect, test, type Page, type Route } from '@playwright/test';

import {
  BaijiahaoAutomationPolicySchema,
  BrowserPlatformAutomationPolicySchema,
  PlatformAccountResponseSchema,
} from './platform-account.schema';

const TENANT_ID = '10000000-0000-4000-8000-000000000091';
const WORKSPACE_ID = '20000000-0000-4000-8000-000000000091';
const ACCOUNT_ID = '30000000-0000-4000-8000-000000000091';
const PROJECT_ID = '40000000-0000-4000-8000-000000000091';
const POLICY_ID = '50000000-0000-4000-8000-000000000091';
const MANUAL_RUN_ID = '60000000-0000-4000-8000-000000000091';
const MANUAL_PACKAGE_ID = '70000000-0000-4000-8000-000000000091';
const MANUAL_VARIANT_ID = '80000000-0000-4000-8000-000000000091';
const MANUAL_VERSION_ID = '90000000-0000-4000-8000-000000000091';
const MANUAL_REPORT_ID = 'a0000000-0000-4000-8000-000000000091';
const SECRET = 'pub-01-super-secret-token';

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    { name: 'geo_csrf', url: 'http://127.0.0.1:34121', value: 'x'.repeat(43) },
  ]);
  await mockRole(page, 'publisher');
  await page.route('**/api/v1/workspaces?*', (route) =>
    json(route, {
      data: [workspace()],
      meta: { next_cursor: null, request_id: 'pub-workspaces' },
    }),
  );
});

test('provides a clear return path to publishing tasks', async ({ page }) => {
  await page.route('**/api/v1/platform-accounts**', (route) =>
    json(route, { data: [], meta: { request_id: 'account-list' } }),
  );

  await page.goto('/pub-01');

  await expect(page.getByRole('link', { name: '返回发布任务' })).toHaveAttribute('href', '/pub-02');
});

test('connects an API account without ever echoing its credential', async ({ page }) => {
  let items: Record<string, unknown>[] = [];
  let createBody: Record<string, unknown> | undefined;
  await page.route('**/api/v1/platform-accounts**', async (route) => {
    if (route.request().method() === 'POST') {
      createBody = route.request().postDataJSON() as Record<string, unknown>;
      items = [account({ version: 1 })];
      await json(route, { data: items[0], meta: { request_id: 'account-create' } }, 201);
      return;
    }
    await json(route, { data: items, meta: { request_id: 'account-list' } });
  });

  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/pub-01');
  await expect(page.getByRole('heading', { name: '还没有可用账号' })).toBeVisible();
  await page.getByRole('button', { name: '连接账号' }).click();
  await page.getByLabel('工作区').last().selectOption(WORKSPACE_ID);
  await page.getByLabel('账号名称（自己识别用）').fill('官网生产账号');
  await page.getByLabel('自动发布').check();
  await page.getByLabel('官网发布 API 根地址').fill('https://publisher.example.test');
  await page.getByLabel('发布令牌').fill(SECRET);
  await page.getByRole('button', { name: '保存并测试连接' }).click();

  await expect(page.getByText('平台账号已连接；凭证已安全保存且不会回显。')).toBeVisible();
  await expect(page.getByText('官网生产账号')).toBeVisible();
  await expect(page.getByRole('link', { name: '打开发布后台' })).toHaveAttribute(
    'target',
    '_blank',
  );
  await expect(page.getByLabel('发布令牌')).toHaveCount(0);
  await expect(page.getByText(SECRET, { exact: false })).toHaveCount(0);
  expect(createBody).toMatchObject({
    credential: { base_url: 'https://publisher.example.test', bearer_token: SECRET },
    display_name: '官网生产账号',
    platform_code: 'official_site',
    publish_mode: 'api',
    workspace_id: WORKSPACE_ID,
  });
  expect(JSON.stringify(items)).not.toContain(SECRET);
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

test('marks the five required Lieju account fields and identifies optional contacts', async ({
  page,
}) => {
  await page.route('**/api/v1/platform-accounts**', (route) =>
    json(route, { data: [], meta: { request_id: 'lieju-required-fields' } }),
  );

  await page.goto('/pub-01');
  await page.getByRole('button', { name: '连接账号' }).click();
  const connectForm = page.getByRole('form', { name: '连接平台账号' });
  await connectForm.getByRole('combobox', { exact: true, name: '平台' }).selectOption('lieju');

  await expect(connectForm.getByText('列举网必填', { exact: true })).toHaveCount(5);
  await expect(
    connectForm.getByText('标有“列举网必填”的五项资料必须填写；QQ 和微信号可选。'),
  ).toBeVisible();
  await expect(connectForm.getByLabel('QQ（可选）')).toBeVisible();
  await expect(connectForm.getByLabel('微信号（可选）')).toBeVisible();
});

test('edits credentials, tests, stops, restores and deletes with optimistic versions', async ({
  page,
}) => {
  let current = account({ version: 1 });
  let removed = false;
  const writes: {
    body: unknown;
    headers: Record<string, string>;
    method: string;
    path: string;
  }[] = [];
  await page.route('**/api/v1/platform-accounts**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      await json(route, { data: removed ? [] : [current], meta: { request_id: 'account-list' } });
      return;
    }
    writes.push({
      body: request.postData() ? (request.postDataJSON() as unknown) : null,
      headers: request.headers(),
      method: request.method(),
      path,
    });
    if (path.endsWith('/test')) {
      current = account({ version: current.version + 1 });
      await json(route, {
        data: {
          account_id: ACCOUNT_ID,
          capabilities: current.capabilities,
          checked_at: '2026-07-16T01:00:00.000Z',
          publish_mode: 'api',
          status: 'active',
          version: current.version,
        },
        meta: { request_id: 'account-test' },
      });
      return;
    }
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() as { display_name: string; timezone: string };
      current = {
        ...account({ version: current.version + 1 }),
        display_name: body.display_name,
        timezone: body.timezone,
      };
    } else if (request.method() === 'DELETE') {
      current = account({ status: 'disabled', version: current.version + 1 });
      removed = true;
    } else {
      current = account({
        status: path.endsWith('/disable') ? 'disabled' : 'active',
        version: current.version + 1,
      });
    }
    const response = { data: current, meta: { request_id: 'account-write' } };
    PlatformAccountResponseSchema.parse(response);
    await json(route, response);
  });

  await page.goto('/pub-01');
  const refreshResponse = page.waitForResponse((response) => response.url().endsWith('/refresh'));
  await page.getByRole('button', { name: '重新验证授权' }).click();
  expect((await refreshResponse).ok()).toBe(true);
  await expect(page.getByText('连接状态已重新验证。')).toBeVisible();
  await page.getByRole('button', { name: '测试连接' }).click();
  await expect(page.getByText('连接测试已完成。')).toBeVisible();

  await page.getByRole('button', { name: '修改账号' }).click();
  const editForm = page.getByRole('form', { name: '编辑账号 官网生产账号' });
  await editForm.getByLabel('账号名称').fill('官网新账号');
  await editForm.getByLabel('时区').fill('Asia/Hong_Kong');
  await editForm.getByLabel('新的发布 API 根地址').fill('https://publisher-new.example.test');
  await editForm.getByLabel('新的发布令牌').fill('rotated-secret');
  await editForm.getByRole('button', { name: '保存修改' }).click();
  await expect(
    page.getByText('账号信息已保存。新凭证已替换旧凭证，且不会在页面回显。'),
  ).toBeVisible();
  await expect(page.getByText('官网新账号')).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept('账号停用'));
  await page.getByRole('button', { name: '停止使用' }).click();
  await expect(page.getByText('账号已停止使用，不会再用于新发布任务。')).toBeVisible();
  await page.getByRole('button', { name: '恢复使用' }).click();
  await expect(page.getByText('账号已恢复使用。')).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '删除账号' }).click();
  await expect(page.getByText('账号已删除。')).toBeVisible();
  await expect(page.getByRole('heading', { name: '还没有可用账号' })).toBeVisible();

  expect(writes.map(({ path }) => path)).toEqual([
    `/api/v1/platform-accounts/${ACCOUNT_ID}/refresh`,
    `/api/v1/platform-accounts/${ACCOUNT_ID}/test`,
    `/api/v1/platform-accounts/${ACCOUNT_ID}`,
    `/api/v1/platform-accounts/${ACCOUNT_ID}/disable`,
    `/api/v1/platform-accounts/${ACCOUNT_ID}/restore`,
    `/api/v1/platform-accounts/${ACCOUNT_ID}`,
  ]);
  expect(writes.map(({ method }) => method)).toEqual([
    'POST',
    'POST',
    'PATCH',
    'POST',
    'POST',
    'DELETE',
  ]);
  expect(writes.map(({ headers }) => headers['content-type'] ?? null)).toEqual([
    'application/json',
    null,
    'application/json',
    'application/json',
    null,
    null,
  ]);
  expect(writes.map(({ body }) => body)).toMatchObject([
    {},
    null,
    {},
    { reason: '账号停用' },
    null,
    null,
  ]);
  expect(writes.map(({ headers }) => headers['if-match'])).toEqual([
    '"1"',
    '"2"',
    '"3"',
    '"4"',
    '"5"',
    '"6"',
  ]);
  expect(
    writes.every(({ headers }) => /^[A-Za-z0-9_-]{43}$/u.test(headers['x-csrf-token'] ?? '')),
  ).toBe(true);
  expect(writes[2]?.body).toMatchObject({
    credential: {
      base_url: 'https://publisher-new.example.test',
      bearer_token: 'rotated-secret',
    },
    display_name: '官网新账号',
  });
  expect(writes[3]?.body).toEqual({ reason: '账号停用' });
  expect(JSON.stringify(writes)).not.toContain('credential_ciphertext');
});

test('updates or clears encrypted Lieju posting details without echoing old values', async ({
  page,
}) => {
  let current = liejuAccount();
  let updateBody: Record<string, unknown> | undefined;
  await page.route('**/api/v1/platform-accounts**', async (route) => {
    const request = route.request();
    if (request.method() === 'PATCH') {
      updateBody = request.postDataJSON() as Record<string, unknown>;
      current = { ...current, version: current.version + 1 };
      await json(route, { data: current, meta: { request_id: 'lieju-account-update' } });
      return;
    }
    await json(route, { data: [current], meta: { request_id: 'lieju-account-list' } });
  });

  await page.goto('/pub-01');
  await page.getByRole('button', { name: '修改账号' }).click();
  const editForm = page.getByRole('form', { name: '编辑账号 列举网生产账号' });
  await expect(editForm.getByText('已保存的联系方式经过加密，不会回显。')).toBeVisible();
  await expect(editForm.getByText('列举网必填', { exact: true })).toHaveCount(5);
  await expect(
    editForm.getByText(
      '标有“列举网必填”的资料必须已保存在账号中；修改时留空表示沿用已保存值，无需重复填写。',
    ),
  ).toBeVisible();
  await editForm.getByLabel('广州区域').selectOption('79');
  await editForm.getByLabel('新联系电话').fill('02085627757');
  await editForm.getByLabel('清空已保存的微信号').check();
  await editForm.getByRole('button', { name: '保存修改' }).click();

  await expect(
    page.getByText('账号信息已保存。新凭证已替换旧凭证，且不会在页面回显。'),
  ).toBeVisible();
  expect(updateBody).toMatchObject({
    credential: {
      delivery_method: 'official_api',
      posting_profile: {
        mobile_phone: '02085627757',
        wechat: '',
        zone_id: '79',
      },
    },
  });
  expect(updateBody?.['credential']).not.toHaveProperty('api_key');
});

test('persists platform, status and workspace filters in the URL', async ({ page }) => {
  const listUrls: string[] = [];
  await page.route('**/api/v1/platform-accounts**', async (route) => {
    listUrls.push(route.request().url());
    await json(route, { data: [], meta: { request_id: 'filtered-list' } });
  });

  await page.goto('/pub-01');
  await page.getByText('查找账号（可选）').click();
  const filters = page.getByRole('form', { name: '平台账号筛选' });
  await filters.getByRole('combobox', { name: '平台' }).selectOption('zhihu');
  await filters.getByRole('combobox', { name: '连接状态' }).selectOption('reauth');
  await filters.getByRole('combobox', { name: '工作区' }).selectOption(WORKSPACE_ID);
  await page.getByRole('button', { name: '查找' }).click();

  await expect(page).toHaveURL(/platform_code=zhihu/u);
  await expect(page).toHaveURL(/status=reauth/u);
  await expect(page).toHaveURL(new RegExp(`workspace_id=${WORKSPACE_ID}`, 'u'));
  await expect.poll(() => listUrls.at(-1) ?? '').toContain('platform_code=zhihu');
  expect(listUrls.at(-1)).toContain('status=reauth');
  expect(listUrls.at(-1)).toContain(`workspace_id=${WORKSPACE_ID}`);
});

test('enables single-item publishing and the daily ten-article plan for one project', async ({
  page,
}) => {
  let savedBody: unknown;
  await page.route('**/api/v1/projects?*', (route) =>
    json(route, {
      data: [{ id: PROJECT_ID, name: '官网内容项目', status: 'active' }],
      meta: { request_id: 'project-list' },
    }),
  );
  await page.route('**/api/v1/platform-accounts**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/official-site-automation')) {
      if (request.method() === 'PUT') {
        savedBody = request.postDataJSON();
        await json(route, {
          data: automationPolicy(true),
          meta: { request_id: 'automation-save' },
        });
        return;
      }
      await json(route, { data: [], meta: { request_id: 'automation-list' } });
      return;
    }
    await json(route, { data: [account({ version: 1 })], meta: { request_id: 'account-list' } });
  });

  await page.goto('/pub-01');
  await page.getByRole('button', { name: '官网自动发布' }).click();
  await expect(page.getByRole('heading', { name: '官网自动发布' })).toBeVisible();
  await expect(page.getByText('GEO 总分 ≥85', { exact: false })).toBeVisible();
  await page.getByLabel('每天自动生产并排期发布 10 篇').check();
  await page.getByRole('button', { name: '保存自动发布设置' }).click();

  await expect(page.getByText('已开启每日计划：系统每天准备 10 篇合格内容')).toBeVisible();
  expect(savedBody).toEqual({ daily_enabled: true, enabled: true, project_id: PROJECT_ID });
});

test('recovers when the automation service is briefly unavailable during deployment', async ({
  page,
}) => {
  let automationRequests = 0;
  await page.route('**/api/v1/projects?*', (route) =>
    json(route, {
      data: [{ id: PROJECT_ID, name: '官网内容项目', status: 'active' }],
      meta: { request_id: 'project-list' },
    }),
  );
  await page.route('**/api/v1/platform-accounts**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/official-site-automation')) {
      automationRequests += 1;
      if (automationRequests === 1) {
        await route.fulfill({ body: 'Service unavailable', status: 503 });
        return;
      }
      await json(route, {
        data: [automationPolicy(true)],
        meta: { request_id: 'automation-recovered' },
      });
      return;
    }
    await json(route, { data: [account({ version: 1 })], meta: { request_id: 'account-list' } });
  });

  await page.goto('/pub-01');
  await page.getByRole('button', { name: '官网自动发布' }).click();

  await expect(page.getByText('服务刚刚不可用，正在自动重新连接…')).toBeVisible();
  await expect(page.getByLabel('每天自动生产并排期发布 10 篇')).toBeVisible();
  expect(automationRequests).toBe(2);
});

test('restarts an exhausted daily batch while keeping the previous attempt', async ({ page }) => {
  let current = automationPolicy(true, {
    attempt_no: 1,
    attempted_count: 30,
    business_date: '2026-07-27',
    in_progress_count: 0,
    last_error_message: '已尝试 30 篇，仍未补足 10 篇合格内容。',
    published_count: 0,
    queued_count: 0,
    qualified_count: 3,
    restart_allowed: true,
    retired_count: 27,
    running_count: 0,
    scheduled_count: 0,
    status: 'attention_required',
    target_count: 10,
    version: 4,
  });
  let restartRequest:
    { body: Record<string, unknown>; idempotencyKey: string | undefined } | undefined;
  await page.route('**/api/v1/projects?*', (route) =>
    json(route, {
      data: [{ id: PROJECT_ID, name: '官网内容项目', status: 'active' }],
      meta: { request_id: 'project-list' },
    }),
  );
  await page.route('**/api/v1/platform-accounts**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/official-site-automation/daily-batch/restart')) {
      restartRequest = {
        body: request.postDataJSON() as Record<string, unknown>,
        idempotencyKey: request.headers()['idempotency-key'],
      };
      current = automationPolicy(true, {
        attempt_no: 2,
        attempted_count: 0,
        business_date: '2026-07-27',
        in_progress_count: 0,
        last_error_message: null,
        published_count: 0,
        queued_count: 0,
        qualified_count: 3,
        restart_allowed: false,
        retired_count: 0,
        running_count: 0,
        scheduled_count: 0,
        status: 'running',
        target_count: 10,
        version: 1,
      });
      await json(route, { data: current, meta: { request_id: 'daily-restart' } }, 201);
      return;
    }
    if (path.endsWith('/official-site-automation')) {
      await json(route, { data: [current], meta: { request_id: 'automation-list' } });
      return;
    }
    await json(route, { data: [account({ version: 1 })], meta: { request_id: 'account-list' } });
  });

  await page.goto('/pub-01');
  await page.getByRole('button', { name: '官网自动发布' }).click();
  await expect(page.getByText('今日发布进度（第 1 次尝试）')).toBeVisible();
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('新尝试只补足剩余 7 篇');
    void dialog.accept();
  });
  await page.getByRole('button', { name: '重新发起今日批次' }).click();

  await expect(page.getByText('已重新发起今日第 2 次尝试')).toBeVisible();
  await expect(page.getByText(/补足剩余 7 篇/u)).toBeVisible();
  await expect(page.getByText('今日发布进度（第 2 次尝试）')).toBeVisible();
  expect(restartRequest?.body).toEqual({
    expected_batch_version: 4,
    project_id: PROJECT_ID,
  });
  expect(restartRequest?.idempotencyKey).toMatch(/^official-site-daily-batch-restart-/u);
});

test('stops a running daily batch without deleting completed records', async ({ page }) => {
  let current = automationPolicy(true, {
    attempt_no: 2,
    attempted_count: 30,
    business_date: '2026-07-27',
    in_progress_count: 3,
    last_error_message: null,
    published_count: 0,
    queued_count: 2,
    qualified_count: 2,
    restart_allowed: false,
    retired_count: 25,
    running_count: 1,
    scheduled_count: 0,
    status: 'running',
    target_count: 10,
    version: 7,
  });
  let cancelRequest:
    { body: Record<string, unknown>; idempotencyKey: string | undefined } | undefined;
  let restartRequest:
    { body: Record<string, unknown>; idempotencyKey: string | undefined } | undefined;
  await page.route('**/api/v1/projects?*', (route) =>
    json(route, {
      data: [{ id: PROJECT_ID, name: '官网内容项目', status: 'active' }],
      meta: { request_id: 'project-list' },
    }),
  );
  await page.route('**/api/v1/platform-accounts**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/official-site-automation/daily-batch/cancel')) {
      cancelRequest = {
        body: request.postDataJSON() as Record<string, unknown>,
        idempotencyKey: request.headers()['idempotency-key'],
      };
      current = automationPolicy(true, {
        ...current.today_batch!,
        in_progress_count: 0,
        last_error_message: '今日批次已由用户手动终止，不再生成新候选或自动排期。',
        queued_count: 0,
        restart_allowed: true,
        retired_count: 28,
        running_count: 0,
        status: 'cancelled',
        version: 8,
      });
      await json(route, { data: current, meta: { request_id: 'daily-cancel' } });
      return;
    }
    if (path.endsWith('/official-site-automation/daily-batch/restart')) {
      restartRequest = {
        body: request.postDataJSON() as Record<string, unknown>,
        idempotencyKey: request.headers()['idempotency-key'],
      };
      current = automationPolicy(true, {
        attempt_no: 3,
        attempted_count: 0,
        business_date: '2026-07-27',
        in_progress_count: 0,
        last_error_message: null,
        published_count: 0,
        queued_count: 0,
        qualified_count: 2,
        restart_allowed: false,
        retired_count: 0,
        running_count: 0,
        scheduled_count: 0,
        status: 'running',
        target_count: 10,
        version: 1,
      });
      await json(route, { data: current, meta: { request_id: 'daily-restart' } }, 201);
      return;
    }
    if (path.endsWith('/official-site-automation')) {
      await json(route, { data: [current], meta: { request_id: 'automation-list' } });
      return;
    }
    await json(route, { data: [account({ version: 1 })], meta: { request_id: 'account-list' } });
  });

  await page.goto('/pub-01');
  await page.getByRole('button', { name: '官网自动发布' }).click();
  await expect(page.getByText('今日发布进度（第 2 次尝试）')).toBeVisible();
  await expect(page.getByText('等待处理', { exact: true })).toBeVisible();
  await expect(page.getByText('AI 正在处理', { exact: true })).toBeVisible();
  await expect(page.getByText(/新建和补位时最多保持 3 篇候选/u)).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '终止今日任务' }).click();

  await expect(page.getByText('今日第 2 次任务已终止')).toBeVisible();
  await expect(page.getByText('已取消', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '终止今日任务' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重新发起今日批次' })).toBeVisible();
  expect(cancelRequest?.body).toEqual({
    expected_batch_version: 7,
    project_id: PROJECT_ID,
  });
  expect(cancelRequest?.idempotencyKey).toMatch(/^official-site-daily-batch-cancel-/u);

  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('新尝试只补足剩余 8 篇');
    void dialog.accept();
  });
  await page.getByRole('button', { name: '重新发起今日批次' }).click();
  await expect(page.getByText('已重新发起今日第 3 次尝试')).toBeVisible();
  await expect(page.getByText(/补足剩余 8 篇/u)).toBeVisible();
  await expect(page.getByText('今日发布进度（第 3 次尝试）')).toBeVisible();
  expect(restartRequest?.body).toEqual({
    expected_batch_version: 8,
    project_id: PROJECT_ID,
  });
  expect(restartRequest?.idempotencyKey).toMatch(/^official-site-daily-batch-restart-/u);
});

test('shows actionable Baijiahao manual-required items', async ({ page }) => {
  const requests: string[] = [];
  await page.route('**/api/v1/projects?*', (route) => {
    requests.push(new URL(route.request().url()).pathname);
    return json(route, {
      data: [{ id: PROJECT_ID, name: '百家号内容项目', status: 'active' }],
      meta: { request_id: 'project-list' },
    });
  });
  await page.route('**/api/v1/platform-accounts**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (path.endsWith('/baijiahao-browser-session')) {
      await json(route, {
        data: baijiahaoPolicy().browser_session,
        meta: { request_id: 'baijiahao-session' },
      });
      return;
    }
    if (path.endsWith('/baijiahao-automation')) {
      await json(route, { data: [baijiahaoPolicy()], meta: { request_id: 'baijiahao-policy' } });
      return;
    }
    await json(route, {
      data: [baijiahaoAccount()],
      meta: { request_id: 'account-list' },
    });
  });

  await page.goto('/pub-01');
  await page.getByRole('button', { name: '百家号自动化' }).click();
  await expect
    .poll(() => requests)
    .toContain(`/api/v1/platform-accounts/${ACCOUNT_ID}/baijiahao-automation`);
  expect(requests).not.toContain(
    `/api/v1/platform-accounts/${ACCOUNT_ID}/baijiahao-browser-session`,
  );
  expect(requests).toContain('/api/v1/projects');

  await expect(page.getByText('任务正在运行')).toBeVisible();
  await expect(page.getByText(/候选 2 · 正文尚未生成/u)).toBeVisible();
  await expect(page.getByText(/生成正文/u)).toBeVisible();
  await page.getByRole('button', { name: '实时核验登录态' }).click();
  await expect
    .poll(() => requests)
    .toContain(`/api/v1/platform-accounts/${ACCOUNT_ID}/baijiahao-browser-session`);

  await expect(page.getByRole('heading', { name: '需要人工处理的内容' })).toBeVisible();
  await expect(page.getByText('广州搬家前如何系统准备')).toBeVisible();
  await expect(page.getByText(/达到最大重写次数后仍未通过质量门禁/u)).toBeVisible();
  await expect(page.getByRole('link', { name: '查看全文和处理' })).toHaveAttribute(
    'href',
    `/cont-04?id=${MANUAL_PACKAGE_ID}`,
  );
  await expect(page.getByRole('link', { name: '查看质量报告' })).toHaveAttribute(
    'href',
    `/qual-01?id=${MANUAL_VARIANT_ID}`,
  );
});

test('restarts an exhausted Baijiahao batch without hiding the previous attempt', async ({
  page,
}) => {
  const base = baijiahaoPolicy();
  let current = BaijiahaoAutomationPolicySchema.parse({
    ...base,
    today_batch: {
      ...base.today_batch!,
      active_items: [],
      attempted_count: 3,
      in_progress_count: 0,
      last_error_message: '候选上限已耗尽。',
      manual_items: [],
      manual_required_count: 0,
      restart_allowed: true,
      status: 'attention_required' as const,
      version: 4,
    },
  });
  let restartRequest: Record<string, unknown> | null = null;
  await page.route('**/api/v1/projects?*', (route) =>
    json(route, {
      data: [{ id: PROJECT_ID, name: '百家号内容项目', status: 'active' }],
      meta: { request_id: 'project-list' },
    }),
  );
  await page.route('**/api/v1/platform-accounts**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/baijiahao-automation/daily-batch/restart')) {
      restartRequest = request.postDataJSON() as Record<string, unknown>;
      current = BaijiahaoAutomationPolicySchema.parse({
        ...current,
        today_batch: {
          ...current.today_batch,
          attempt_no: 2,
          attempted_count: 0,
          last_error_message: null,
          restart_allowed: false,
          status: 'running',
          version: 1,
        },
      });
      await json(route, { data: current, meta: { request_id: 'daily-restart' } }, 201);
      return;
    }
    if (path.endsWith('/baijiahao-automation')) {
      await json(route, { data: [current], meta: { request_id: 'baijiahao-policy' } });
      return;
    }
    await json(route, { data: [baijiahaoAccount()], meta: { request_id: 'account-list' } });
  });

  await page.goto('/pub-01');
  await page.getByRole('button', { name: '百家号自动化' }).click();
  await expect(page.getByText(/第 1 次尝试/u)).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '保留历史并重新发起' }).click();

  await expect(page.getByText('已创建今日第 2 次尝试，历史候选保持不变。')).toBeVisible();
  await expect(page.getByText('等待下一次后台巡检（第 2 次尝试）')).toBeVisible();
  expect(restartRequest).toEqual({ expected_batch_version: 4, project_id: PROJECT_ID });
});

test('shows actionable Sohu daily-batch items', async ({ page }) => {
  let keywordSyncRequest: Record<string, unknown> | null = null;
  let qualityCheckCount = 0;
  await page.route('**/api/v1/platform-accounts**', (route) =>
    json(route, { data: [sohuAccount()], meta: { request_id: 'account-list' } }),
  );
  await page.route('**/api/v1/projects?*', (route) =>
    json(route, {
      data: [
        { id: PROJECT_ID, name: '搜狐自动化项目', status: 'active', workspace_id: WORKSPACE_ID },
      ],
      meta: { next_cursor: null, request_id: 'projects' },
    }),
  );
  await page.route(`**/api/v1/platform-accounts/${ACCOUNT_ID}/content-automation`, (route) =>
    json(route, { data: [browserPlatformPolicy()], meta: { request_id: 'automation' } }),
  );
  await page.route('**/api/v1/keyword-sets/sync-platform-scope', (route) => {
    keywordSyncRequest = route.request().postDataJSON() as Record<string, unknown>;
    return json(route, {
      data: {
        active_keyword_count: 8,
        changed_count: 6,
        matched_count: 10,
        platform_codes: ['sohu'],
        project_id: PROJECT_ID,
      },
      meta: { request_id: 'keyword-sync' },
    });
  });
  await page.route(`**/api/v1/content-variants/${MANUAL_VARIANT_ID}/quality-check`, (route) => {
    qualityCheckCount += 1;
    return json(route, { data: { id: MANUAL_RUN_ID }, meta: { request_id: 'quality-check' } }, 202);
  });
  await page.route(
    `**/api/v1/platform-accounts/${ACCOUNT_ID}/sohu-browser-session/login`,
    (route) =>
      json(route, {
        data: {
          account_id: ACCOUNT_ID,
          authenticated_at: '2026-08-16T00:00:00.000Z',
          last_verified_at: '2026-08-16T00:00:00.000Z',
          qr_expires_at: null,
          status: 'authenticated',
          version: 1,
        },
        meta: { request_id: 'sohu-login' },
      }),
  );

  await page.goto('/pub-01');
  await page.getByRole('button', { name: '搜狐号登录' }).click();
  await expect(page.getByRole('heading', { name: '搜狐号托管浏览器' })).toBeVisible();
  await page.getByRole('button', { name: '一键同步项目关键词到搜狐号' }).click();
  await expect(page.getByText(/已检查 10 个项目关键词，新增 6 个搜狐号适用范围/u)).toBeVisible();
  expect(keywordSyncRequest).toEqual({ platform_codes: ['sohu'], project_id: PROJECT_ID });
  await expect(page.getByText('需要处理的内容')).toBeVisible();
  await expect(page.getByText('候选 1 · 广州搬家准备清单')).toBeVisible();
  await expect(page.getByRole('link', { name: '查看全文和处理' })).toHaveAttribute(
    'href',
    `/cont-04?id=${MANUAL_PACKAGE_ID}`,
  );
  await expect(page.getByRole('link', { name: '查看质量报告' })).toHaveAttribute(
    'href',
    `/qual-01?id=${MANUAL_VARIANT_ID}`,
  );
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '批量重新质检（1）' }).click();
  await expect(page.getByText('已批量发起 1 篇搜狐号内容重新质检。')).toBeVisible();
  expect(qualityCheckCount).toBe(1);
});

test('retries a prerequisite-blocked Sohu daily batch after explicit confirmation', async ({
  page,
}) => {
  const blocked = browserPlatformPolicy();
  blocked.today_batch = {
    ...blocked.today_batch!,
    attempted_count: 0,
    last_error_message: '项目没有适用于 sohu 的关键词。',
    manual_items: [],
    manual_required_count: 0,
    retry_allowed: true,
    version: 4,
  };
  let retryRequest: Record<string, unknown> | null = null;
  await page.route('**/api/v1/platform-accounts**', (route) =>
    json(route, { data: [sohuAccount()], meta: { request_id: 'account-list' } }),
  );
  await page.route('**/api/v1/projects?*', (route) =>
    json(route, {
      data: [
        { id: PROJECT_ID, name: '搜狐自动化项目', status: 'active', workspace_id: WORKSPACE_ID },
      ],
      meta: { next_cursor: null, request_id: 'projects' },
    }),
  );
  await page.route(
    `**/api/v1/platform-accounts/${ACCOUNT_ID}/content-automation**`,
    async (route) => {
      if (route.request().method() === 'POST') {
        retryRequest = route.request().postDataJSON() as Record<string, unknown>;
        await json(route, {
          data: {
            ...blocked,
            today_batch: {
              ...blocked.today_batch!,
              last_error_message: null,
              retry_allowed: false,
              status: 'running',
              version: 5,
            },
          },
          meta: { request_id: 'daily-retry' },
        });
        return;
      }
      await json(route, { data: [blocked], meta: { request_id: 'automation' } });
    },
  );
  await page.route(
    `**/api/v1/platform-accounts/${ACCOUNT_ID}/sohu-browser-session/login`,
    (route) =>
      json(route, {
        data: {
          account_id: ACCOUNT_ID,
          authenticated_at: '2026-08-16T00:00:00.000Z',
          last_verified_at: '2026-08-16T00:00:00.000Z',
          qr_expires_at: null,
          status: 'authenticated',
          version: 1,
        },
        meta: { request_id: 'sohu-login' },
      }),
  );

  await page.goto('/pub-01');
  await page.getByRole('button', { name: '搜狐号登录' }).click();
  await expect(page.getByText('今日批次因前置资料缺失而停止')).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '重试今日批次' }).click();
  await expect(page.getByText('今日搜狐号批次已恢复运行，调度器将继续生成候选。')).toBeVisible();
  expect(retryRequest).toEqual({ expected_batch_version: 4, project_id: PROJECT_ID });
});

test('restarts an exhausted Sohu batch as a new attempt', async ({ page }) => {
  const base = browserPlatformPolicy();
  let current = BrowserPlatformAutomationPolicySchema.parse({
    ...base,
    today_batch: {
      ...base.today_batch!,
      attempted_count: 3,
      last_error_message: '候选上限已耗尽。',
      manual_items: [],
      manual_required_count: 0,
      restart_allowed: true,
      status: 'attention_required' as const,
      version: 5,
    },
  });
  let restartRequest: Record<string, unknown> | null = null;
  await page.route('**/api/v1/platform-accounts**', (route) =>
    json(route, { data: [sohuAccount()], meta: { request_id: 'account-list' } }),
  );
  await page.route('**/api/v1/projects?*', (route) =>
    json(route, {
      data: [
        { id: PROJECT_ID, name: '搜狐自动化项目', status: 'active', workspace_id: WORKSPACE_ID },
      ],
      meta: { next_cursor: null, request_id: 'projects' },
    }),
  );
  await page.route(
    `**/api/v1/platform-accounts/${ACCOUNT_ID}/content-automation**`,
    async (route) => {
      if (route.request().url().endsWith('/daily-batch/restart')) {
        restartRequest = route.request().postDataJSON() as Record<string, unknown>;
        current = BrowserPlatformAutomationPolicySchema.parse({
          ...current,
          today_batch: {
            ...current.today_batch,
            attempt_no: 2,
            attempted_count: 0,
            last_error_message: null,
            restart_allowed: false,
            status: 'running',
            version: 1,
          },
        });
        await json(route, { data: current, meta: { request_id: 'daily-restart' } }, 201);
        return;
      }
      await json(route, { data: [current], meta: { request_id: 'automation' } });
    },
  );

  await page.goto('/pub-01');
  await page.getByRole('button', { name: '搜狐号登录' }).click();
  await expect(page.getByText(/今日第 1 次尝试/u)).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '保留历史并重新发起' }).click();

  await expect(page.getByText('已创建今日第 2 次尝试，历史候选保持不变。')).toBeVisible();
  await expect(
    page.getByText('今日第 2 次尝试：本次已尝试 0，当天累计已排期 0，已发布 0'),
  ).toBeVisible();
  expect(restartRequest).toEqual({ expected_batch_version: 5, project_id: PROJECT_ID });
});

test('distinguishes Baijiahao browser attention from login expiry and allows re-verification', async ({
  page,
}) => {
  const policy = baijiahaoPolicy();
  const attentionPolicy = {
    ...policy,
    browser_session: {
      ...policy.browser_session!,
      status: 'attention_required' as const,
    },
  };
  await page.route('**/api/v1/projects?*', (route) =>
    json(route, {
      data: [{ id: PROJECT_ID, name: '百家号内容项目', status: 'active' }],
      meta: { request_id: 'project-list' },
    }),
  );
  await page.route('**/api/v1/platform-accounts**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/baijiahao-browser-session')) {
      await json(route, {
        data: policy.browser_session,
        meta: { request_id: 'baijiahao-session-verified' },
      });
      return;
    }
    if (path.endsWith('/baijiahao-automation')) {
      await json(route, {
        data: [attentionPolicy],
        meta: { request_id: 'baijiahao-policy-attention' },
      });
      return;
    }
    await json(route, { data: [baijiahaoAccount()], meta: { request_id: 'account-list' } });
  });

  await page.goto('/pub-01');
  await page.getByRole('button', { name: '百家号自动化' }).click();
  await expect(page.getByText('浏览器操作需人工处理（未判定登录过期）')).toBeVisible();
  await expect(page.getByText(/当前是浏览器操作安全暂停，未判定为登录过期/u)).toBeVisible();
  await expect(page.getByRole('button', { name: '检查并恢复' })).toBeVisible();

  await page.getByRole('button', { name: '实时核验登录态' }).click();
  await expect(page.getByText('登录态已实时核验：已登录。')).toBeVisible();
  await expect(page.getByText('状态：已登录')).toBeVisible();
});

test('denies non-publisher roles before requesting account data', async ({ page }) => {
  let accountRequests = 0;
  await page.unroute('**/api/v1/auth/tenants');
  await mockRole(page, 'viewer');
  await page.route('**/api/v1/platform-accounts**', async (route) => {
    accountRequests += 1;
    await route.abort();
  });

  await page.goto('/pub-01');
  await expect(page.getByRole('heading', { name: '无权管理平台账号' })).toBeVisible();
  expect(accountRequests).toBe(0);
});

function account({
  status = 'active',
  version,
}: {
  status?: 'active' | 'disabled';
  version: number;
}) {
  return {
    capabilities: {
      export: true,
      get_status: true,
      metrics: true,
      publish: true,
      version: '1.0.0',
      warnings: [],
    },
    created_at: '2026-07-16T00:00:00.000Z',
    display_name: '官网生产账号',
    id: ACCOUNT_ID,
    platform_code: 'official_site',
    provider_account_id: 'site-main',
    publishing_url: 'https://cms.example.test/publish',
    publish_mode: 'api',
    scopes: ['publish'],
    status,
    tenant_id: TENANT_ID,
    timezone: 'Asia/Shanghai',
    token_expires_at: '2026-08-16T00:00:00.000Z',
    updated_at: '2026-07-16T00:00:00.000Z',
    version,
    workspace_id: WORKSPACE_ID,
  };
}

function baijiahaoAccount() {
  return {
    ...account({ version: 1 }),
    display_name: '百家号生产账号',
    id: ACCOUNT_ID,
    platform_code: 'baijiahao',
    provider_account_id: null,
    publishing_url: null,
    token_expires_at: null,
  };
}

function sohuAccount() {
  return {
    ...account({ version: 1 }),
    display_name: '搜狐号生产账号',
    id: ACCOUNT_ID,
    platform_code: 'sohu',
    provider_account_id: null,
    publishing_url: 'https://mp.sohu.com/',
    token_expires_at: null,
  };
}

function liejuAccount() {
  return {
    ...account({ version: 1 }),
    capabilities: {
      delivery_method: 'official_api',
      get_status: false,
      publish: true,
    },
    display_name: '列举网生产账号',
    platform_code: 'lieju',
    provider_account_id: null,
    publishing_url: null,
    token_expires_at: null,
  };
}

function browserPlatformPolicy() {
  return {
    account_id: ACCOUNT_ID,
    brand_consistency_min: 90,
    daily_candidate_limit: 3,
    daily_enabled: true,
    daily_generation_time: '00:30:00',
    daily_schedule_times: ['10:00:00'],
    daily_target_count: 1,
    daily_timezone: 'Asia/Shanghai',
    enabled: true,
    factual_accuracy_min: 90,
    geo_total_min: 85,
    id: POLICY_ID,
    max_rewrites: 3,
    platform_code: 'sohu',
    platform_fit_min: 80,
    project_id: PROJECT_ID,
    publish_attempt_limit: 3,
    question_coverage_min: 80,
    readability_safety_min: 85,
    tenant_id: TENANT_ID,
    today_batch: {
      attempt_no: 1,
      attempted_count: 1,
      business_date: '2026-08-16',
      in_progress_count: 0,
      last_error_message: '需要人工处理',
      manual_items: [
        {
          automation_run_id: MANUAL_RUN_ID,
          candidate_no: 1,
          content_version_id: MANUAL_VERSION_ID,
          last_error: { code: 'QUALITY_GATE_FAILED_AFTER_MAX_REWRITES' },
          package_id: MANUAL_PACKAGE_ID,
          publish_job_id: null,
          quality_report_id: MANUAL_REPORT_ID,
          rewrite_count: 3,
          title: '广州搬家准备清单',
          updated_at: '2026-08-16T01:00:00.000Z',
          variant_id: MANUAL_VARIANT_ID,
        },
      ],
      manual_required_count: 1,
      published_count: 0,
      restart_allowed: false,
      retry_allowed: false,
      retired_count: 0,
      scheduled_count: 0,
      status: 'attention_required',
      target_count: 1,
      version: 1,
    },
    updated_at: '2026-08-16T01:00:00.000Z',
    version: 1,
    workspace_id: WORKSPACE_ID,
  };
}

function baijiahaoPolicy() {
  return BaijiahaoAutomationPolicySchema.parse({
    account_id: ACCOUNT_ID,
    brand_consistency_min: 90,
    browser_session: {
      account_id: ACCOUNT_ID,
      authenticated_at: '2026-08-04T00:00:00.000Z',
      last_verified_at: '2026-08-04T00:00:00.000Z',
      qr_expires_at: null,
      status: 'authenticated',
      version: 1,
    },
    daily_candidate_limit: 3,
    daily_enabled: true,
    daily_generation_time: '06:30:00',
    daily_schedule_times: ['10:00:00'],
    daily_target_count: 1,
    daily_timezone: 'Asia/Shanghai',
    enabled: true,
    factual_accuracy_min: 90,
    geo_total_min: 85,
    id: POLICY_ID,
    independent_fallback_enabled: false,
    max_rewrites: 3,
    max_source_similarity: 0.82,
    platform_fit_min: 80,
    project_id: PROJECT_ID,
    publish_attempt_limit: 3,
    question_coverage_min: 80,
    readability_safety_min: 85,
    source_mode: 'official_site_derived',
    tenant_id: TENANT_ID,
    today_batch: {
      attempt_no: 1,
      active_items: [
        {
          automation_run_id: 'a5000000-0000-4000-8000-000000000001',
          candidate_no: 2,
          item_status: 'generating',
          run_status: 'generation_pending',
          title: null,
          updated_at: '2026-08-04T00:20:00.000Z',
        },
      ],
      attempted_count: 2,
      business_date: '2026-08-04',
      in_progress_count: 1,
      last_activity_at: '2026-08-04T00:20:00.000Z',
      last_error_message: null,
      manual_items: [
        {
          automation_run_id: MANUAL_RUN_ID,
          candidate_no: 1,
          content_version_id: MANUAL_VERSION_ID,
          last_error: {
            blocking_rules: ['gate.question_coverage'],
            code: 'QUALITY_GATE_FAILED_AFTER_MAX_REWRITES',
          },
          package_id: MANUAL_PACKAGE_ID,
          publish_job_id: null,
          quality_report_id: MANUAL_REPORT_ID,
          rewrite_count: 3,
          source_mode: 'official_site_derived',
          title: '广州搬家前如何系统准备',
          updated_at: '2026-08-04T00:18:19.000Z',
          variant_id: MANUAL_VARIANT_ID,
        },
      ],
      manual_required_count: 1,
      published_count: 0,
      restart_allowed: false,
      retired_count: 0,
      scheduled_count: 0,
      skipped_count: 0,
      status: 'running',
      target_count: 1,
      version: 1,
    },
    updated_at: '2026-08-04T00:18:19.000Z',
    version: 1,
    workspace_id: WORKSPACE_ID,
  });
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

function automationPolicy(enabled: boolean, todayBatch: Record<string, unknown> | null = null) {
  return {
    account_id: ACCOUNT_ID,
    brand_consistency_min: 90,
    daily_candidate_limit: 30,
    daily_enabled: enabled,
    daily_generation_time: '00:00:00',
    daily_schedule_times: [
      '08:00:00',
      '09:30:00',
      '11:00:00',
      '12:30:00',
      '14:00:00',
      '15:30:00',
      '17:00:00',
      '18:30:00',
      '20:00:00',
      '21:30:00',
    ],
    daily_target_count: 10,
    daily_timezone: 'Asia/Shanghai',
    enabled,
    factual_accuracy_min: 90,
    geo_total_min: 85,
    id: POLICY_ID,
    max_rewrites: 3,
    platform_fit_min: 80,
    project_id: PROJECT_ID,
    publish_attempt_limit: 3,
    question_coverage_min: 80,
    readability_safety_min: 85,
    tenant_id: TENANT_ID,
    today_batch: todayBatch,
    updated_at: '2026-07-23T00:00:00.000Z',
    version: 1,
    workspace_id: WORKSPACE_ID,
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
      meta: { request_id: 'role' },
    }),
  );
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}
