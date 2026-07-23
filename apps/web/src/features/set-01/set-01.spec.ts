import { expect, test } from '@playwright/test';

const TENANT_ID = '10000000-0000-4000-8000-000000000098';
const OWNER_ID = '20000000-0000-4000-8000-000000000098';
const MEMBER_ID = '30000000-0000-4000-8000-000000000098';
const WORKSPACE_ID = '40000000-0000-4000-8000-000000000098';
const INVITATION_ID = '50000000-0000-4000-8000-000000000098';

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    { name: 'geo_csrf', url: 'http://127.0.0.1:34128', value: 'x'.repeat(43) },
  ]);
  await page.route('**/api/v1/auth/tenants', (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [
          {
            id: TENANT_ID,
            is_active: true,
            last_used_at: null,
            name: '成员企业',
            role_code: 'tenant_owner',
            slug: 'members',
          },
        ],
        meta: { request_id: 'tenant' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route('**/api/v1/workspaces?*', (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [{ id: WORKSPACE_ID, name: '主工作区' }],
        meta: { next_cursor: null, request_id: 'workspaces' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route('**/api/v1/invitations?*', (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: {
          items: [invitation('pending@example.com')],
          next_cursor: null,
        },
        meta: { request_id: 'invitations' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route('**/api/v1/memberships?*', (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: {
          items: [member(OWNER_ID, 'Owner', 'owner@example.com', 'tenant_owner')],
          next_cursor: null,
        },
        meta: { request_id: 'members' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
});

test('shows mobile member and invitation states and stores filters in the URL', async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/set-01');
  await expect(page.getByRole('heading', { name: '成员与邀请' })).toBeVisible();
  await expect(page.getByText('pending@example.com')).toBeVisible();
  await expect(page.getByText('最后一名 active Owner 不可禁用或降级。')).toBeVisible();
  await page.getByLabel('状态筛选').selectOption('active');
  await expect(page).toHaveURL(/status=active/u);
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

test('invites, updates, disables and restores a member with protected write headers', async ({
  page,
}) => {
  let inviteRequest: { body: Record<string, unknown>; headers: Record<string, string> } | undefined;
  let updateHeaders: Record<string, string> | undefined;
  let disableHeaders: Record<string, string> | undefined;
  let restoreHeaders: Record<string, string> | undefined;
  await page.unroute('**/api/v1/memberships?*');
  await page.route('**/api/v1/memberships?*', (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: {
          items: [
            member(OWNER_ID, 'Owner', 'owner@example.com', 'tenant_owner'),
            member(MEMBER_ID, 'Editor', 'editor@example.com', 'content_editor'),
          ],
          next_cursor: null,
        },
        meta: { request_id: 'members' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route('**/api/v1/invitations', async (route) => {
    inviteRequest = {
      body: route.request().postDataJSON() as Record<string, unknown>,
      headers: route.request().headers(),
    };
    await route.fulfill({
      body: JSON.stringify({ data: invitation('new@example.com'), meta: { request_id: 'invite' } }),
      contentType: 'application/json',
      status: 201,
    });
  });
  await page.route(`**/api/v1/memberships/${MEMBER_ID}`, async (route) => {
    updateHeaders = route.request().headers();
    await route.fulfill({
      body: JSON.stringify({
        data: { ...member(MEMBER_ID, 'Editor', 'editor@example.com', 'analyst'), version: 2 },
        meta: { request_id: 'update' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.route(`**/api/v1/memberships/${MEMBER_ID}/disable`, async (route) => {
    disableHeaders = route.request().headers();
    await route.fulfill({
      body: JSON.stringify({
        data: {
          ...member(MEMBER_ID, 'Editor', 'editor@example.com', 'analyst'),
          status: 'disabled',
          version: 3,
        },
        meta: { request_id: 'disable' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.route(`**/api/v1/memberships/${MEMBER_ID}/restore`, async (route) => {
    restoreHeaders = route.request().headers();
    await route.fulfill({
      body: JSON.stringify({
        data: { ...member(MEMBER_ID, 'Editor', 'editor@example.com', 'analyst'), version: 4 },
        meta: { request_id: 'restore' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto('/set-01');
  await page.getByLabel('邮箱').fill('NEW@EXAMPLE.COM');
  await page.getByLabel('主工作区').first().check();
  await page.getByRole('button', { name: '发送邀请' }).click();
  const editor = page.locator('article').filter({ hasText: 'editor@example.com' });
  await editor.getByLabel('角色').selectOption('analyst');
  await editor.getByRole('button', { name: '保存' }).click();
  await editor.getByRole('button', { name: '禁用' }).click();
  await editor.getByRole('button', { name: '恢复' }).click();

  expect(inviteRequest?.body).toMatchObject({ email: 'new@example.com', role_code: 'viewer' });
  expect(inviteRequest?.headers['idempotency-key']).toMatch(/^member-invite-/u);
  expect(updateHeaders?.['if-match']).toBe('"1"');
  expect(updateHeaders?.['x-csrf-token']).toBe('x'.repeat(43));
  expect(disableHeaders?.['if-match']).toBe('"2"');
  expect(restoreHeaders?.['if-match']).toBe('"3"');
});

test('does not request disable for the last active owner', async ({ page }) => {
  let disableRequests = 0;
  await page.route(`**/api/v1/memberships/${OWNER_ID}/disable`, (route) => {
    disableRequests += 1;
    return route.abort();
  });
  await page.goto('/set-01');
  await expect(page.getByRole('button', { name: '禁用' })).toBeDisabled();
  expect(disableRequests).toBe(0);
});

function member(id: string, displayName: string, email: string, role: string) {
  return {
    created_at: '2026-07-16T00:00:00.000Z',
    display_name: displayName,
    email,
    id,
    role_code: role,
    status: 'active',
    tenant_id: TENANT_ID,
    updated_at: '2026-07-16T01:00:00.000Z',
    user_id: id,
    version: 1,
    workspace_scope: { workspace_ids: [] },
  };
}

function invitation(email: string) {
  return {
    created_at: '2026-07-16T00:00:00.000Z',
    email,
    expires_at: '2026-07-23T00:00:00.000Z',
    id: INVITATION_ID,
    role_code: 'viewer',
    status: 'pending',
    tenant_id: TENANT_ID,
    workspace_scope: { workspace_ids: [] },
  };
}
