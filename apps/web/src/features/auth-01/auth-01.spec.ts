import { expect, test } from '@playwright/test';

test('uses the same generic error for unknown email and wrong password', async ({ page }) => {
  const requests: { body: Record<string, unknown>; csrf: string | undefined }[] = [];
  await page.route('**/api/v1/auth/login', async (route) => {
    const request = route.request();
    const body = request.postDataJSON() as Record<string, unknown>;
    requests.push({ body, csrf: request.headers()['x-csrf-token'] });
    const message =
      body['email'] === 'unknown@example.com' ? 'User does not exist' : 'Wrong password';
    await route.fulfill({
      body: JSON.stringify({ error: { code: 'AUTH_REQUIRED', message } }),
      contentType: 'application/json',
      status: 401,
    });
  });

  await page.goto('/auth-01');
  const email = page.getByLabel('企业邮箱');
  const password = page.getByLabel('密码');
  const loginError = page.locator('form [role="alert"]');

  await email.fill('unknown@example.com');
  await password.fill('wrong-password');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(loginError).toHaveText('邮箱或密码不正确，请重试。');
  const firstError = await loginError.textContent();

  await email.fill('member@example.com');
  await password.fill('wrong-password');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(loginError).toHaveText('邮箱或密码不正确，请重试。');
  const secondError = await loginError.textContent();

  expect(firstError).toBe('邮箱或密码不正确，请重试。');
  expect(secondError).toBe(firstError);
  await expect(loginError).not.toContainText('unknown@example.com');
  await expect(loginError).not.toContainText('User does not exist');
  await expect(loginError).not.toContainText('Wrong password');
  expect(requests).toHaveLength(2);
  expect(requests[0]?.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(requests[0]?.body).toEqual({
    email: 'unknown@example.com',
    password: 'wrong-password',
    remember_me: false,
  });
});

test('submits remember-me and starts automatic tenant entry after login', async ({ page }) => {
  let requestBody: Record<string, unknown> | undefined;
  await page.route('**/api/v1/auth/login', async (route) => {
    requestBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      body: JSON.stringify({
        data: {
          active_tenant_id: null,
          expires_at: '2026-08-15T00:00:00.000Z',
          user: { display_name: 'Member', email: 'member@example.com', id: crypto.randomUUID() },
        },
        meta: { request_id: 'request-auth-01-success' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto('/auth-01?return_to=%2Fcont-03%3Fstatus%3Ddraft');
  await page.getByLabel('企业邮箱').fill('member@example.com');
  await page.getByLabel('密码').fill('correct-password');
  await page.getByLabel('30 天内保持登录').check();
  await page.getByRole('button', { name: '登录' }).click();

  await expect(page).toHaveURL(/\/auth-02\?return_to=%2Fcont-03%3Fstatus%3Ddraft&auto=1$/u);
  expect(requestBody).toMatchObject({ remember_me: true });
});

test('explains an expired session without exposing technical details', async ({ page }) => {
  await page.goto('/auth-01?reason=session_expired&return_to=%2Fdash-01');

  await expect(page.getByRole('status')).toHaveText('登录已过期，请重新登录。完成后将返回原页面。');
  await expect(page.getByRole('status')).not.toContainText(/cookie|session|401/iu);
});

test('explains logout and account switching in plain language', async ({ page }) => {
  await page.goto('/auth-01?reason=logged_out');
  await expect(page.getByRole('status')).toHaveText('你已安全退出登录。');

  await page.goto('/auth-01?reason=switch_account&return_to=%2Fcont-03');
  await expect(page.getByRole('status')).toHaveText('已退出原账号，请登录要切换到的账号。');
});

test('keeps password-reset responses generic and supports keyboard use on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.route('**/api/v1/auth/password/forgot', async (route) => {
    await route.fulfill({
      body: JSON.stringify({ error: { message: 'Email does not exist' } }),
      contentType: 'application/json',
      status: 404,
    });
  });

  await page.goto('/auth-01');
  await page.getByLabel('企业邮箱').fill('unknown@example.com');
  await page.getByRole('button', { name: '忘记密码？' }).click();

  await expect(page.getByRole('status')).toHaveText('如果该邮箱已注册，你将收到密码重置邮件。');
  await expect(page.getByRole('status')).not.toContainText('unknown@example.com');
  await expect(page.getByRole('status')).not.toContainText('does not exist');
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');

  await page.getByLabel('企业邮箱').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '忘记密码？' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('密码')).toBeFocused();
});
