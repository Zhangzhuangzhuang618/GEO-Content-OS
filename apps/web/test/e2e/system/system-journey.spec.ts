import { expect, test } from '@playwright/test';

const stages = [
  { heading: 'Brief 列表', path: '/cont-01' },
  { heading: '审核队列', path: '/rev-01' },
  { heading: '平台账号', path: '/pub-01' },
  { heading: '数据总览', path: '/anl-01' },
] as const;

test('exposes the production, review, publishing, and analytics stages as accessible pages', async ({
  page,
}) => {
  for (const stage of stages) {
    const response = await page.goto(stage.path);
    expect(response?.status(), stage.path).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: stage.heading })).toBeVisible();
    await expect(page.locator('main#main-content')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  }
});
