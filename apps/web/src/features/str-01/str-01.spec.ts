import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const DRAFT_ID = '10000000-0000-4000-8000-000000000074';
const PUBLISHED_ID = '20000000-0000-4000-8000-000000000074';
const TENANT_ID = '30000000-0000-4000-8000-000000000074';
const WORKSPACE_ID = '40000000-0000-4000-8000-000000000074';
const CREATOR_ID = '50000000-0000-4000-8000-000000000074';

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([{ name: 'geo_csrf', url: 'http://127.0.0.1:34104', value: 'csrf' }]);
  await mockRole(page, 'strategy_editor');
  await page.route('**/api/v1/brand-profiles?*', async (route) => {
    const status = new URL(route.request().url()).searchParams.get('status');
    const items = profiles().filter((profile) => !status || profile.status === status);
    await route.fulfill({
      body: JSON.stringify({
        data: items,
        meta: { next_cursor: null, request_id: 'brand-profile-list' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
});

test('lists, filters and compares immutable strategy versions', async ({ page }) => {
  await page.goto('/str-01');

  await expect(page.getByRole('heading', { name: '品牌策略' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '名称' })).toBeVisible();
  await expect(page.getByText('GEO 企业版')).toBeVisible();
  await expect(page.getByText('GEO 专业版')).toBeVisible();

  await page.getByLabel('选择版本 v1').check();
  await page.getByLabel('选择版本 v2').check();
  await expect(page.getByLabel('版本比较')).toHaveCount(0);
  await page.getByRole('button', { name: '比较所选版本' }).click();
  await expect(page.getByLabel('版本比较')).toContainText('GEO 企业版');
  await expect(page.getByLabel('版本比较')).toContainText('GEO 专业版');

  await page.getByLabel('状态筛选').selectOption('published');
  await expect(page).toHaveURL(/\/str-01\?status=published$/u);
  await expect(page.getByText('GEO 企业版')).toHaveCount(0);
  await expect(page.getByText('GEO 专业版')).toBeVisible();
});

test('shows permitted actions and sends the frozen publish contract', async ({ page }) => {
  let publishRequest:
    { body: Record<string, unknown>; headers: Record<string, string> } | undefined;
  let retireRequest: { body: Record<string, unknown>; headers: Record<string, string> } | undefined;
  await page.route(`**/api/v1/brand-profiles/${DRAFT_ID}/publish`, async (route) => {
    publishRequest = {
      body: route.request().postDataJSON() as Record<string, unknown>,
      headers: route.request().headers(),
    };
    await route.fulfill({
      body: JSON.stringify({
        data: { ...profiles()[0], published_at: '2026-07-15T01:00:00.000Z', status: 'published' },
        meta: { request_id: 'publish' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.route(`**/api/v1/brand-profiles/${PUBLISHED_ID}/retire`, async (route) => {
    retireRequest = {
      body: route.request().postDataJSON() as Record<string, unknown>,
      headers: route.request().headers(),
    };
    await route.fulfill({
      body: JSON.stringify({
        data: { ...profiles()[1], status: 'retired' },
        meta: { request_id: 'retire' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto('/str-01');
  await expect(page.getByRole('link', { name: '创建策略' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发布' })).toBeVisible();
  await expect(page.getByRole('button', { name: '退役' })).toBeVisible();
  await page.getByRole('button', { name: '发布' }).click();
  await expect(page.getByRole('status')).toContainText('策略已发布');
  expect(publishRequest?.body).toEqual({ version: 1 });
  expect(publishRequest?.headers['if-match']).toBe('"1"');
  expect(publishRequest?.headers['x-csrf-token']).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(publishRequest?.headers['idempotency-key']).toMatch(/^brand-profile-publish-/u);

  page.once('dialog', (dialog) => dialog.accept('计划升级'));
  await page.getByRole('button', { name: '退役' }).click();
  await expect(page.getByRole('status')).toContainText('策略已退役');
  expect(retireRequest?.body).toEqual({ reason: '计划升级' });
  expect(retireRequest?.headers['if-match']).toBe('"2"');
  expect(retireRequest?.headers['x-csrf-token']).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(retireRequest?.headers['idempotency-key']).toMatch(/^brand-profile-retire-/u);
});

test('keeps the list read-only for a viewer', async ({ page }) => {
  await mockRole(page, 'viewer');
  await page.goto('/str-01');

  await expect(page.getByText('GEO 企业版')).toBeVisible();
  await expect(page.getByRole('link', { name: '查看' })).toHaveCount(2);
  await expect(page.getByRole('link', { name: '创建策略' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发布' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '退役' })).toHaveCount(0);
});

async function mockRole(page: Page, role: string) {
  await page.route('**/api/v1/auth/tenants', async (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [
          {
            id: TENANT_ID,
            is_active: true,
            last_used_at: null,
            name: '示例企业',
            role_code: role,
            slug: 'demo',
          },
        ],
        meta: { request_id: `role-${role}` },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
}

function profiles() {
  return [
    profile(DRAFT_ID, 1, 'draft', 'GEO 企业版', null),
    profile(PUBLISHED_ID, 2, 'published', 'GEO 专业版', '2026-07-15T01:00:00.000Z'),
  ] as const;
}

function profile(
  id: string,
  version: number,
  status: 'draft' | 'published',
  positioning: string,
  publishedAt: string | null,
) {
  return {
    created_at: '2026-07-15T00:00:00.000Z',
    created_by: CREATOR_ID,
    id,
    profile: {
      audience: ['内容负责人'],
      banned: [],
      compliance: [],
      cta: null,
      differentiators: [],
      positioning,
      tone: '专业、克制、可验证',
    },
    published_at: publishedAt,
    schema_version: 'brand-profile@1',
    status,
    tenant_id: TENANT_ID,
    version,
    workspace_id: WORKSPACE_ID,
  };
}
