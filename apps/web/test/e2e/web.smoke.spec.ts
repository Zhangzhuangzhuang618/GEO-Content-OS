import { expect, test } from '@playwright/test';

test('redirects the root route to login', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL(/\/auth-01$/u);
  await expect(page).toHaveTitle('登录 | GEO Content OS');
  await expect(page.getByRole('heading', { name: '登录工作空间' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
});

test('renders the application not-found boundary', async ({ page }) => {
  const response = await page.goto('/missing-smoke-route');

  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('页面不存在');
  await expect(page.getByRole('link', { name: '返回首页' })).toHaveAttribute('href', '/');
});
