import { expect, test } from '@playwright/test';

const TOKEN = 'a'.repeat(43);

test('accepts an invitation and enters the invited enterprise', async ({ page }) => {
  let requestBody: Record<string, unknown> | undefined;
  let csrf: string | undefined;
  await page.route(`**/api/v1/invitations/${TOKEN}/accept`, async (route) => {
    requestBody = route.request().postDataJSON() as Record<string, unknown>;
    csrf = route.request().headers()['x-csrf-token'];
    await route.fulfill({
      body: JSON.stringify({
        data: {
          active_tenant_id: '10000000-0000-4000-8000-000000000001',
          expires_at: '2026-08-15T00:00:00.000Z',
          user: {
            display_name: '受邀管理员',
            email: 'owner@example.com',
            id: '20000000-0000-4000-8000-000000000001',
          },
        },
        meta: { request_id: 'invitation-accepted' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.route('**/dash-01', (route) =>
    route.fulfill({ body: '<main>企业首页</main>', contentType: 'text/html', status: 200 }),
  );

  await page.goto(`/invitations/accept?token=${TOKEN}`);
  await page.getByLabel('姓名').fill('受邀管理员');
  await page.getByLabel('账号密码', { exact: true }).fill('secure owner password');
  await page.getByLabel('再次输入密码').fill('secure owner password');
  await page.getByRole('button', { name: '接受邀请并进入企业' }).click();

  await expect(page).toHaveURL(/\/dash-01$/u);
  expect(requestBody).toEqual({ display_name: '受邀管理员', password: 'secure owner password' });
  expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/u);
});

test('shows invalid and expired invitation states without technical details', async ({ page }) => {
  await page.goto('/invitations/accept');
  await expect(page.getByRole('heading', { name: '邀请链接无效' })).toBeVisible();

  await page.route(`**/api/v1/invitations/${TOKEN}/accept`, (route) =>
    route.fulfill({
      body: JSON.stringify({ error: { code: 'RESOURCE_NOT_FOUND', message: 'not found' } }),
      contentType: 'application/json',
      status: 404,
    }),
  );
  await page.goto(`/invitations/accept?token=${TOKEN}`);
  await page.getByLabel('姓名').fill('受邀管理员');
  await page.getByLabel('账号密码', { exact: true }).fill('secure owner password');
  await page.getByLabel('再次输入密码').fill('secure owner password');
  await page.getByRole('button', { name: '接受邀请并进入企业' }).click();

  const alert = page.locator('form').getByRole('alert');
  await expect(alert).toHaveText('邀请已失效、已使用或企业不可用，请联系邀请人重新发送。');
  await expect(alert).not.toContainText(/RESOURCE_NOT_FOUND|not found|404/u);
});

test('validates matching passwords before sending the request', async ({ page }) => {
  let requests = 0;
  await page.route(`**/api/v1/invitations/${TOKEN}/accept`, (route) => {
    requests += 1;
    return route.abort();
  });

  await page.goto(`/invitations/accept?token=${TOKEN}`);
  await page.getByLabel('姓名').fill('受邀管理员');
  await page.getByLabel('账号密码', { exact: true }).fill('secure owner password');
  await page.getByLabel('再次输入密码').fill('different owner password');
  await page.getByRole('button', { name: '接受邀请并进入企业' }).click();

  await expect(page.locator('form').getByRole('alert')).toHaveText('两次输入的密码不一致。');
  expect(requests).toBe(0);
});
