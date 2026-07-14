import { expect, test } from '@playwright/test';

const PROFILE_ID = '10000000-0000-4000-8000-000000000075';
const WORKSPACE_ID = '20000000-0000-4000-8000-000000000075';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/auth/tenants', async (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [
          {
            id: '30000000-0000-4000-8000-000000000075',
            is_active: true,
            last_used_at: null,
            name: '示例企业',
            role_code: 'strategy_editor',
            slug: 'demo',
          },
        ],
        meta: { request_id: 'role' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route('**/api/v1/workspaces?*', async (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [{ id: WORKSPACE_ID, name: '品牌工作区', status: 'active' }],
        meta: { next_cursor: null, request_id: 'workspaces' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
});

test('keeps a published profile read-only', async ({ page }) => {
  await page.route(`**/api/v1/brand-profiles/${PROFILE_ID}`, async (route) =>
    route.fulfill({
      body: JSON.stringify(profileResponse('published')),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.goto(`/str-02?id=${PROFILE_ID}`);
  await expect(page.getByText('该版本已冻结，只可查看。')).toBeVisible();
  await expect(page.getByLabel('品牌定位')).toBeDisabled();
  await expect(page.getByLabel('目标受众（每行一项）')).toBeDisabled();
  await expect(page.getByRole('button', { name: /保存|发布/u })).toHaveCount(0);
});

test('creates an immutable draft then publishes the returned version', async ({ page }) => {
  let createRequest: { body: Record<string, unknown>; headers: Record<string, string> } | undefined;
  let publishRequest:
    { body: Record<string, unknown>; headers: Record<string, string> } | undefined;
  await page.route('**/api/v1/brand-profiles', async (route) => {
    createRequest = {
      body: route.request().postDataJSON() as Record<string, unknown>,
      headers: route.request().headers(),
    };
    await route.fulfill({
      body: JSON.stringify(profileResponse('draft')),
      contentType: 'application/json',
      status: 201,
    });
  });
  await page.route(`**/api/v1/brand-profiles/${PROFILE_ID}/publish`, async (route) => {
    publishRequest = {
      body: route.request().postDataJSON() as Record<string, unknown>,
      headers: route.request().headers(),
    };
    await route.fulfill({
      body: JSON.stringify(profileResponse('published')),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto('/str-02');
  await page.getByLabel('品牌定位').fill('企业级 GEO 内容生产操作系统');
  await page.getByLabel('品牌语气').fill('专业、克制、可验证');
  await page.getByLabel('目标受众（每行一项）').fill('内容负责人\n品牌团队');
  await page.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.getByRole('status')).toContainText('草稿版本 v3 已保存');
  expect(createRequest?.body).toMatchObject({
    workspace_id: WORKSPACE_ID,
    profile: { audience: ['内容负责人', '品牌团队'] },
  });
  expect(createRequest?.headers['x-csrf-token']).toMatch(/^[A-Za-z0-9_-]{43}$/u);

  await page.getByRole('button', { name: '发布新版本' }).click();
  await expect(page.getByRole('status')).toContainText('版本 v3 已发布');
  expect(publishRequest?.body).toEqual({ version: 3 });
  expect(publishRequest?.headers['if-match']).toBe('"3"');
});

test('denies non-strategy roles and remains usable at mobile width', async ({ page }) => {
  await page.route('**/api/v1/auth/tenants', async (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [
          {
            id: '30000000-0000-4000-8000-000000000075',
            is_active: true,
            last_used_at: null,
            name: '示例企业',
            role_code: 'viewer',
            slug: 'demo',
          },
        ],
        meta: { request_id: 'viewer' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/str-02');
  await expect(page.getByRole('heading', { name: '无权编辑品牌策略' })).toBeVisible();
  await expect(page.getByRole('form')).toHaveCount(0);
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

function profileResponse(status: 'draft' | 'published') {
  return {
    data: {
      created_at: '2026-07-15T00:00:00.000Z',
      created_by: '40000000-0000-4000-8000-000000000075',
      id: PROFILE_ID,
      profile: {
        audience: ['内容负责人'],
        banned: [],
        compliance: [],
        cta: null,
        differentiators: [],
        positioning: '企业级 GEO 内容生产操作系统',
        tone: '专业、克制、可验证',
      },
      published_at: status === 'published' ? '2026-07-15T01:00:00.000Z' : null,
      schema_version: 'brand-profile@1',
      status,
      tenant_id: '30000000-0000-4000-8000-000000000075',
      version: 3,
      workspace_id: WORKSPACE_ID,
    },
    meta: { request_id: `profile-${status}` },
  };
}
