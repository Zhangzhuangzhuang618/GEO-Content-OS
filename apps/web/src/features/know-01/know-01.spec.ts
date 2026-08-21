import { expect, test } from '@playwright/test';
const ACTIVE_ID = '10000000-0000-4000-8000-000000000078';
const EXPIRED_ID = '10000000-0000-4000-8000-000000000178';

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    { name: 'geo_csrf', url: 'http://127.0.0.1:34108', value: 'x'.repeat(43) },
  ]);
  await page.route('**/api/v1/workspaces?*', async (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [workspace()],
        meta: { next_cursor: null, request_id: 'workspaces' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route('**/api/v1/projects?*', async (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [{ id: projectId, name: '知识项目', status: 'active' }],
        meta: { next_cursor: null, request_id: 'projects' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route('**/api/v1/auth/tenants', async (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [
          {
            id: '20000000-0000-4000-8000-000000000078',
            is_active: true,
            last_used_at: null,
            name: '知识企业',
            role_code: 'content_editor',
            slug: 'knowledge',
          },
        ],
        meta: { request_id: 'role' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route('**/api/v1/sources?*', async (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [
          source(ACTIVE_ID, 'active', '工作空间共享白皮书', null),
          source(EXPIRED_ID, 'expired', '旧版价格表'),
        ],
        meta: { next_cursor: null, request_id: 'sources' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
});

test('marks expired sources and prevents them from re-entering indexing', async ({ page }) => {
  const detailRequests: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'GET' && request.url().includes('/api/v1/sources/')) {
      detailRequests.push(request.url());
    }
  });
  await page.goto(scopeUrl);
  const expiredRow = page.getByRole('listitem').filter({ hasText: '旧版价格表' });
  await expect(expiredRow.getByText('已失效资料不会进入新的检索。')).toBeVisible();
  await expect(expiredRow.getByRole('button', { name: '重建索引' })).toHaveCount(0);
  const sharedRow = page.getByRole('listitem').filter({ hasText: '工作空间共享白皮书' });
  await expect(sharedRow.getByRole('button', { name: '重建索引' })).toBeVisible();
  await expect(sharedRow.getByText(/完成于/u)).toBeVisible();
  await expect(page.getByRole('link', { name: '工作空间共享白皮书' })).toHaveAttribute(
    'href',
    `/know-03?id=${ACTIVE_ID}&workspace_id=${workspaceId}&project_id=${projectId}`,
  );
  expect(detailRequests).toEqual([]);
});

test('submits exact source hash for reindex and revision for expiry', async ({ page }) => {
  let reindexBody: Record<string, unknown> | undefined;
  let expireHeaders: Record<string, string> | undefined;
  await page.route(`**/api/v1/sources/${ACTIVE_ID}/reindex`, async (route) => {
    reindexBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ body: '{}', contentType: 'application/json', status: 202 });
  });
  await page.route(`**/api/v1/sources/${ACTIVE_ID}`, async (route) => {
    if (route.request().method() === 'DELETE') {
      expireHeaders = route.request().headers();
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fallback();
  });
  await page.goto(scopeUrl);
  const row = page.getByRole('listitem').filter({ hasText: '工作空间共享白皮书' });
  await row.getByRole('button', { name: '重建索引' }).click();
  expect(reindexBody).toMatchObject({ expected_content_hash: 'a'.repeat(64) });
  page.once('dialog', (dialog) => dialog.accept());
  await row.getByRole('button', { name: '标记失效' }).click();
  await expect(row.getByText('已失效资料不会进入新的检索。')).toBeVisible();
  expect(expireHeaders?.['if-match']).toBe('"2026-07-15T01:00:00.000Z"');
});

test('writes filters to the URL and hides write actions from viewers on mobile', async ({
  page,
}) => {
  await page.route('**/api/v1/auth/tenants', async (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [
          {
            id: '20000000-0000-4000-8000-000000000078',
            is_active: true,
            last_used_at: null,
            name: '知识企业',
            role_code: 'viewer',
            slug: 'knowledge',
          },
        ],
        meta: { request_id: 'viewer' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(scopeUrl);
  await page.getByLabel('状态').selectOption('expired');
  await expect(page).toHaveURL(/status=expired/u);
  await expect(page.getByRole('link', { name: '上传资料' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重建索引' })).toHaveCount(0);
  await expect(page.getByLabel('官网服务电话')).toBeDisabled();
  await expect(page.getByRole('button', { name: '保存电话' })).toHaveCount(0);
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

test('lets an enterprise owner maintain the inherited official-site service phone', async ({
  page,
}) => {
  let updateBody: Record<string, unknown> | undefined;
  await page.route('**/api/v1/auth/tenants', async (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [
          {
            id: '20000000-0000-4000-8000-000000000078',
            is_active: true,
            last_used_at: null,
            name: '知识企业',
            role_code: 'tenant_owner',
            slug: 'knowledge',
          },
        ],
        meta: { request_id: 'owner' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route(`**/api/v1/workspaces/${workspaceId}`, async (route) => {
    updateBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      body: JSON.stringify({
        data: {
          ...workspace(),
          settings: {
            official_site_service_phone: '02085627757',
            schema_version: 'workspace-settings@1',
          },
          version: 2,
        },
        meta: { request_id: 'phone-update' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto(scopeUrl);
  await page.getByLabel('官网服务电话').fill('02085627757');
  await page.getByRole('button', { name: '保存电话' }).click();

  await expect(page.getByText('官网服务电话已保存')).toBeVisible();
  expect(updateBody).toMatchObject({
    settings: {
      official_site_service_phone: '02085627757',
      schema_version: 'workspace-settings@1',
    },
  });
});

function source(
  id: string,
  status: 'active' | 'expired',
  title: string,
  sourceProjectId: string | null = projectId,
) {
  return {
    content_hash: 'a'.repeat(64),
    created_at: '2026-07-15T00:00:00.000Z',
    created_by: '30000000-0000-4000-8000-000000000078',
    effective_from: null,
    effective_to: status === 'expired' ? '2026-07-01' : null,
    id,
    language: 'zh-CN',
    mime_type: 'application/pdf',
    parsed_at: '2026-07-15T02:00:00.000Z',
    project_id: sourceProjectId,
    source_type: 'pdf',
    status,
    tenant_id: '20000000-0000-4000-8000-000000000078',
    title,
    trust_level: 'verified',
    updated_at: '2026-07-15T01:00:00.000Z',
    workspace_id: '40000000-0000-4000-8000-000000000078',
  };
}

function workspace() {
  return {
    created_at: '2026-07-15T00:00:00.000Z',
    id: workspaceId,
    name: '知识工作空间',
    settings: { schema_version: 'workspace-settings@1' },
    slug: 'knowledge',
    status: 'active',
    tenant_id: '20000000-0000-4000-8000-000000000078',
    timezone: 'Asia/Shanghai',
    updated_at: '2026-07-15T01:00:00.000Z',
    version: 1,
  };
}

const workspaceId = '40000000-0000-4000-8000-000000000078';
const projectId = '50000000-0000-4000-8000-000000000078';
const scopeUrl = `/know-01?workspace_id=${workspaceId}&project_id=${projectId}`;
