import { test, expect } from '@playwright/test';
import { installA11yApiMocks } from './mock-api';

test('regional mode toggles independently and saves with the existing style', async ({ page }) => {
  await installA11yApiMocks(page);
  const id = '11111111-1111-4111-8111-111111111111';
  const workspace = '20000000-0000-4000-8000-000000000140';
  let policy = {
    account_id: id,
    workspace_id: workspace,
    platform_code: 'official_site',
    default_style: 'standard',
    regional_mode_enabled: false,
    recommended_companies: [],
    version: 1,
  };
  await page.route('**/api/v1/platform-accounts**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/content-policy')) {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON();
        expect(body.default_style).toBe('standard');
        policy = { ...policy, ...body, version: policy.version + 1 };
        delete (policy as Record<string, unknown>).expected_version;
      }
      await route.fulfill({ json: { data: policy, meta: { request_id: 'regional-ui' } } });
      return;
    }
    if (url.pathname === '/api/v1/platform-accounts') {
      await route.fulfill({
        json: {
          data: [
            {
              id,
              workspace_id: workspace,
              tenant_id: '10000000-0000-4000-8000-000000000140',
              platform_code: 'official_site',
              display_name: '区域验收账号',
              provider_account_id: null,
              publishing_url: null,
              publish_mode: 'export',
              status: 'active',
              capabilities: {},
              scopes: [],
              timezone: 'Asia/Shanghai',
              token_expires_at: null,
              created_at: '2026-09-12T00:00:00Z',
              updated_at: '2026-09-12T00:00:00Z',
              version: 1,
            },
          ],
          meta: { request_id: 'regional-ui' },
        },
      });
      return;
    }
    await route.fallback();
  });
  await page.goto('/pub-01');
  await page.getByRole('button', { name: '内容设置', exact: true }).click();
  const checkbox = page.getByRole('checkbox', { name: /区域模式/ });
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await page.getByRole('button', { name: '保存内容设置', exact: true }).click();
  await expect.poll(() => policy.regional_mode_enabled).toBe(true);
  await checkbox.uncheck();
  await page.getByRole('button', { name: '保存内容设置', exact: true }).click();
  await expect.poll(() => policy.regional_mode_enabled).toBe(false);
});
