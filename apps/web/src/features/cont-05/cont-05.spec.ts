import { expect, test, type Page, type Route } from '@playwright/test';

const TENANT_ID = '10000000-0000-4000-8000-000000000086';
const PACKAGE_ID = '50000000-0000-4000-8000-000000000086';
const VARIANT_ID = '70000000-0000-4000-8000-000000000086';
const CURRENT_ID = '80000000-0000-4000-8000-000000000086';
const OLD_ID = '81000000-0000-4000-8000-000000000086';
const BLOCK_ID = '90000000-0000-4000-8000-000000000086';
const HASH = 'a'.repeat(64);

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    { name: 'geo_csrf', url: 'http://127.0.0.1:34115', value: 'x'.repeat(43) },
  ]);
  await mockRole(page, 'content_editor');
  await page.route(`**/api/v1/content-variants/${VARIANT_ID}`, (route) => json(route, detail()));
});

test('saves a complete document with the required variant version', async ({ page }) => {
  let request: { readonly body: unknown; readonly headers: Record<string, string> } | undefined;
  await page.route(`**/api/v1/content-variants/${VARIANT_ID}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      request = { body: route.request().postDataJSON(), headers: route.request().headers() };
      await json(route, detail());
    } else await json(route, detail());
  });
  await page.goto(`/cont-05?id=${VARIANT_ID}`);
  await page.getByLabel('文章标题').fill('更新后的 GEO 标题');
  await page.getByLabel('内容类型').fill('article');
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect(page.getByText('内容已保存。')).toBeVisible();
  expect(request?.headers['if-match']).toBe('"4"');
  expect(request?.headers['idempotency-key']).toMatch(/^content-variant-save-/u);
  expect(request?.body).toMatchObject({
    content: {
      citation_map: [{ citation_ids: [], claim_key: 'claim-1', claim_text: '声明' }],
      platform_code: 'zhihu',
      platform_meta: { content_type: 'article' },
      schema_version: 'content-writer-data@1',
      title: '更新后的 GEO 标题',
    },
  });
});

test('saves an edited scheduled article and requests manual revalidation', async ({ page }) => {
  const sourceJobId = 'c0000000-0000-4000-8000-000000000086';
  let saved: unknown;
  let quality: { readonly body: unknown; readonly headers: Record<string, string> } | undefined;
  await page.route(`**/api/v1/content-variants/${VARIANT_ID}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      saved = route.request().postDataJSON();
      await json(route, detail());
    } else await json(route, detail());
  });
  await page.route(`**/api/v1/content-variants/${VARIANT_ID}/quality-check`, async (route) => {
    quality = {
      body: route.request().postDataJSON(),
      headers: route.request().headers(),
    };
    await json(route, { id: 'c1000000-0000-4000-8000-000000000086' }, 202);
  });

  await page.goto(`/cont-05?id=${VARIANT_ID}&publish_edit=1&publish_job_id=${sourceJobId}`);
  await expect(page.getByText('正在修改已取消排期的文章')).toBeVisible();
  await page.getByLabel('文章标题').fill('人工修改后的发布标题');
  await page.getByRole('button', { name: '保存并重新质检' }).click();

  await expect(page.getByText(/修改已提交重新质检/u)).toBeVisible();
  expect(saved).toMatchObject({ content: { title: '人工修改后的发布标题' } });
  expect(quality?.body).toEqual({
    mode: 'manual_edit',
    source_publish_job_id: sourceJobId,
  });
  expect(quality?.headers['idempotency-key']).toMatch(/^content-publish-edit-quality-/u);
});

test('surfaces 409 without silently overwriting local content', async ({ page }) => {
  let ifMatch: string | undefined;
  await page.route(`**/api/v1/content-variants/${VARIANT_ID}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      ifMatch = route.request().headers()['if-match'];
      await route.fulfill({ status: 409 });
    } else await json(route, detail());
  });
  await page.goto(`/cont-05?id=${VARIANT_ID}`);
  await page.getByLabel('文章标题').fill('本地未保存标题');
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect(page.getByText('版本冲突：服务端内容已变化，本地内容未覆盖')).toBeVisible();
  await expect(page.getByLabel('文章标题')).toHaveValue('本地未保存标题');
  await expect(page.getByRole('button', { name: '重新加载服务端版本' })).toBeVisible();
  expect(ifMatch).toBe('"4"');
});

test('locks a stored block and regenerates with frozen lock keys', async ({ page }) => {
  let lockHeader: string | undefined;
  let regenerate: { readonly body: unknown; readonly headers: Record<string, string> } | undefined;
  let locked = false;
  await page.route(
    `**/api/v1/content-variants/${VARIANT_ID}/blocks/${BLOCK_ID}/lock`,
    async (route) => {
      lockHeader = route.request().headers()['if-match'];
      locked = true;
      await json(route, { id: 'a0000000-0000-4000-8000-000000000086', variant_version: 5 }, 201);
    },
  );
  await page.route(`**/api/v1/content-variants/${VARIANT_ID}/regenerate`, async (route) => {
    regenerate = { body: route.request().postDataJSON(), headers: route.request().headers() };
    await json(route, { id: 'a1000000-0000-4000-8000-000000000086' }, 202);
  });
  await page.unroute(`**/api/v1/content-variants/${VARIANT_ID}`);
  await page.route(`**/api/v1/content-variants/${VARIANT_ID}`, (route) => {
    const value = detail();
    if (locked) value.locks = [blockLock()];
    return json(route, value);
  });
  await page.goto(`/cont-05?id=${VARIANT_ID}`);
  await page.getByRole('button', { name: '锁定段落' }).click();
  await page.getByRole('button', { name: '确认保留' }).click();
  await expect(page.getByRole('button', { name: '解除段落锁' })).toBeVisible();
  await page.getByRole('button', { name: '重新生成此平台内容' }).click();
  expect(lockHeader).toBe('"4"');
  expect(regenerate?.headers['if-match']).toBe('"4"');
  expect(regenerate?.body).toEqual({ locked_block_keys: ['intro'], model_policy: 'balanced' });
});

test('presents a human-readable article editor before technical fields', async ({ page }) => {
  await page.goto(`/cont-05?id=${VARIANT_ID}`);

  await expect(page.getByRole('heading', { name: '编辑内容', level: 1 })).toBeVisible();
  await expect(page.getByLabel('文章标题')).toBeVisible();
  await expect(page.getByLabel('第 1 段内容')).toBeVisible();
  await expect(page.getByLabel('内容类型')).toHaveValue('answer');
  await expect(page.getByText('质量检查通过', { exact: true })).toBeVisible();
  await expect(page.getByText(VARIANT_ID)).not.toBeVisible();
  await expect(page.getByLabel('平台高级设置 JSON')).not.toBeVisible();
});

test('loads diff and rolls back with current variant version', async ({ page }) => {
  let rollbackHeader: string | undefined;
  await page.route(`**/api/v1/content-versions/${CURRENT_ID}/diff?*`, (route) =>
    json(route, {
      base: { content_hash: HASH, id: CURRENT_ID, version_no: 2 },
      blocks: [{ block_key: 'intro', change: 'modified' }],
      fields: [{ field: 'title' }],
      target: { content_hash: HASH, id: OLD_ID, version_no: 1 },
    }),
  );
  await page.route(`**/api/v1/content-versions/${OLD_ID}/rollback`, async (route) => {
    rollbackHeader = route.request().headers()['if-match'];
    await json(route, version(OLD_ID, 1));
  });
  await page.goto(`/cont-05?id=${VARIANT_ID}`);
  await page.getByRole('button', { name: '比较版本' }).click();
  await expect(page.getByText('1 个字段、1 个内容块变化')).toBeVisible();
  await page.getByRole('button', { name: '回滚到此版本' }).click();
  await expect(page.getByText('已回滚到所选版本。')).toBeVisible();
  expect(rollbackHeader).toBe('"4"');
});

test('keeps permission and mobile states safe', async ({ page }) => {
  await mockRole(page, 'viewer');
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`/cont-05?id=${VARIANT_ID}`);
  await expect(page.getByRole('heading', { name: '无权编辑内容' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused();
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

function detail() {
  return {
    citations: [
      {
        chunk_id: 'b0000000-0000-4000-8000-000000000086',
        claim_key: 'claim-1',
        claim_text: '声明',
        content_version_id: CURRENT_ID,
        created_at: '2026-07-15T00:00:00.000Z',
        id: 'b1000000-0000-4000-8000-000000000086',
        quote_hash: HASH,
        quote_text: '证据摘录',
        tenant_id: TENANT_ID,
      },
    ],
    current_content: version(CURRENT_ID, 2),
    locks: [] as ReturnType<typeof blockLock>[],
    quality_report: {
      content_version_id: CURRENT_ID,
      decision: 'pass',
      id: 'b2000000-0000-4000-8000-000000000086',
      score: 91,
      variant_id: VARIANT_ID,
    },
    variant: {
      created_at: '2026-07-15T00:00:00.000Z',
      current_content_version_id: CURRENT_ID,
      id: VARIANT_ID,
      is_required: true,
      package_id: PACKAGE_ID,
      platform_code: 'zhihu',
      quality_score: 91,
      status: 'quality_passed',
      tenant_id: TENANT_ID,
      updated_at: '2026-07-15T01:00:00.000Z',
      version: 4,
    },
    versions: [version(CURRENT_ID, 2), version(OLD_ID, 1)],
  };
}
function version(id: string, versionNo: number) {
  return {
    blocks: [
      {
        block_key: 'intro',
        block_type: 'paragraph',
        content_version_id: id,
        created_at: '2026-07-15T00:00:00.000Z',
        id: BLOCK_ID,
        position: 0,
        tenant_id: TENANT_ID,
        text_hash: HASH,
      },
    ],
    content_hash: HASH,
    content_json: {
      blocks: [{ block_key: 'intro', block_type: 'paragraph', text: '正文' }],
      citation_map: [{ citation_ids: [], claim_key: 'claim-1', claim_text: '声明' }],
      cta: null,
      hashtags: ['GEO'],
      platform_code: 'zhihu',
      platform_meta: { content_type: 'answer' },
      schema_version: 'content-writer-data@1',
      summary: '摘要',
      title: '原始 GEO 标题',
    },
    created_at: '2026-07-15T00:00:00.000Z',
    created_by: '40000000-0000-4000-8000-000000000086',
    id,
    package_id: PACKAGE_ID,
    schema_version: 'content-writer-data@1',
    source_run_id: null,
    tenant_id: TENANT_ID,
    variant_id: VARIANT_ID,
    version_no: versionNo,
  };
}
function blockLock() {
  return {
    block_key: 'intro',
    created_at: '2026-07-15T00:00:00.000Z',
    id: 'a0000000-0000-4000-8000-000000000086',
    locked_by: '40000000-0000-4000-8000-000000000086',
    locked_content_hash: HASH,
    reason: null,
    tenant_id: TENANT_ID,
    updated_at: '2026-07-15T00:00:00.000Z',
    variant_id: VARIANT_ID,
  };
}
async function mockRole(page: Page, role: string) {
  await page.route('**/api/v1/auth/tenants', (route) =>
    json(route, [
      {
        id: TENANT_ID,
        is_active: true,
        last_used_at: null,
        name: '内容企业',
        role_code: role,
        slug: 'content',
      },
    ]),
  );
}
async function json(route: Route, data: unknown, status = 200) {
  await route.fulfill({
    body: JSON.stringify({ data, meta: { request_id: 'cont-05' } }),
    contentType: 'application/json',
    status,
  });
}
