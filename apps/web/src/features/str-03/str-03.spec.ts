import { expect, test } from '@playwright/test';

const NO_EVIDENCE_ID = '10000000-0000-4000-8000-000000000076';
const EVIDENCE_ID = '10000000-0000-4000-8000-000000000176';

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([{ name: 'geo_csrf', url: 'http://127.0.0.1:34109', value: 'csrf' }]);
  await page.route('**/api/v1/auth/tenants', async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        data: [
          {
            id: tenantId,
            is_active: true,
            last_used_at: null,
            name: '策略企业',
            role_code: 'strategy_editor',
            slug: 'strategy',
          },
        ],
        meta: { request_id: 'role' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.route('**/api/v1/topic-candidates?*', async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        data: [topic(NO_EVIDENCE_ID, false), topic(EVIDENCE_ID, true)],
        meta: { next_cursor: null, request_id: 'topics' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.route('**/api/v1/workspaces?*', (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [{ id: workspaceId, name: '策略工作区', status: 'active' }],
        meta: { next_cursor: null, request_id: 'workspaces' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route('**/api/v1/projects?*', (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [{ id: projectId, name: 'GEO 项目', status: 'active' }],
        meta: { request_id: 'projects' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.route('**/api/v1/keyword-sets?*', (route) =>
    route.fulfill({
      body: JSON.stringify({
        data: [
          {
            created_at: '2026-07-15T00:00:00.000Z',
            id: keywordSetId,
            name: '核心关键词',
            project_id: projectId,
            status: 'active',
            tenant_id: tenantId,
            updated_at: '2026-07-15T00:00:00.000Z',
          },
        ],
        meta: { next_cursor: null, request_id: 'keyword-sets' },
      }),
      contentType: 'application/json',
      status: 200,
    }),
  );
});

test('marks topics without evidence as risk and never adopts them automatically', async ({
  page,
}) => {
  let adoptRequests = 0;
  await page.route('**/api/v1/topic-candidates/*/adopt', async (route) => {
    adoptRequests += 1;
    await route.fulfill({ status: 500 });
  });
  await page.goto('/str-03');
  const risky = page.getByRole('listitem').filter({ hasText: '没有证据的问题' });
  await expect(risky.getByText('缺少资料依据：补充资料前不能采纳为内容需求。')).toBeVisible();
  await expect(risky.getByRole('button', { name: '采纳为内容需求' })).toBeDisabled();
  expect(adoptRequests).toBe(0);
});

test('adopts an evidenced topic with its current version', async ({ page }) => {
  let headers: Record<string, string> | undefined;
  await page.route(`**/api/v1/topic-candidates/${EVIDENCE_ID}/adopt`, async (route) => {
    headers = route.request().headers();
    await route.fulfill({
      body: JSON.stringify({
        data: { id: briefId, title: '有证据的问题' },
        meta: { request_id: 'adopt' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.goto('/str-03');
  await page
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { exact: true, name: '有证据的问题' }) })
    .getByRole('button', { name: '采纳为内容需求' })
    .click();
  await expect(page.getByText('已采纳为内容需求：有证据的问题')).toBeVisible();
  expect(headers?.['if-match']).toBe('"3"');
});

test('queues topic generation without adopting any candidate', async ({ page }) => {
  let generationBody: Record<string, unknown> | undefined;
  let adoptRequests = 0;
  await page.route('**/api/v1/topic-plans/generate', async (route) => {
    generationBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      body: JSON.stringify({
        data: { id: runId, status: 'queued' },
        meta: { request_id: 'generate' },
      }),
      contentType: 'application/json',
      status: 202,
    });
  });
  await page.route('**/api/v1/topic-candidates/*/adopt', async (route) => {
    adoptRequests += 1;
    await route.fulfill({ status: 500 });
  });
  await page.goto('/str-03');
  await page.getByLabel('工作区').selectOption(workspaceId);
  await page.getByLabel('项目').selectOption(projectId);
  await page.getByLabel('核心关键词').check();
  await page.getByLabel('种子问题（逗号或换行分隔）').fill('GEO 是什么');
  await page.getByRole('button', { name: '生成选题' }).click();
  await expect(page.getByText('选题生成已开始，完成后会出现在下方列表中。')).toBeVisible();
  expect(generationBody).toEqual({
    keyword_set_ids: [keywordSetId],
    max_topics: 10,
    platform_codes: ['official_website'],
    project_id: projectId,
    seed_queries: ['GEO 是什么'],
    workspace_id: workspaceId,
  });
  expect(adoptRequests).toBe(0);
});

test('writes filters to URL and hides write actions from viewers on mobile', async ({ page }) => {
  await page.route('**/api/v1/auth/tenants', async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        data: [
          {
            id: tenantId,
            is_active: true,
            last_used_at: null,
            name: '策略企业',
            role_code: 'viewer',
            slug: 'strategy',
          },
        ],
        meta: { request_id: 'viewer' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/str-03');
  await page.getByLabel('风险').selectOption('high');
  await expect(page).toHaveURL(/risk_level=high/u);
  await expect(page.getByRole('button', { name: '生成选题' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '采纳为内容需求' })).toHaveCount(0);
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

function topic(id: string, hasEvidence: boolean) {
  return {
    brief_suggestion: null,
    created_at: '2026-07-15T00:00:00.000Z',
    entities: ['GEO'],
    evidence_ids: hasEvidence ? ['30000000-0000-4000-8000-000000000076'] : [],
    generation_run_id: '40000000-0000-4000-8000-000000000076',
    id,
    intent: 'education',
    platform_codes: ['official_website'],
    priority: hasEvidence ? 80 : 60,
    project_id: '50000000-0000-4000-8000-000000000076',
    question: hasEvidence ? '有证据的问题' : '没有证据的问题',
    risk_level: hasEvidence ? 'low' : 'high',
    status: 'proposed',
    tenant_id: tenantId,
    updated_at: '2026-07-15T01:00:00.000Z',
    version: 3,
    workspace_id: '60000000-0000-4000-8000-000000000076',
  };
}

const tenantId = '20000000-0000-4000-8000-000000000076';
const briefId = '70000000-0000-4000-8000-000000000076';
const runId = '80000000-0000-4000-8000-000000000076';
const projectId = '50000000-0000-4000-8000-000000000076';
const workspaceId = '60000000-0000-4000-8000-000000000076';
const keywordSetId = '90000000-0000-4000-8000-000000000076';
