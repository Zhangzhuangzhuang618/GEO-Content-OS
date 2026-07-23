import { expect, test, type Page, type Route } from '@playwright/test';

const TENANT_ID = '10000000-0000-4000-8000-000000000093';
const JOB_ID = '20000000-0000-4000-8000-000000000093';
const ACCOUNT_ID = '30000000-0000-4000-8000-000000000093';
const VARIANT_ID = '40000000-0000-4000-8000-000000000093';
const CONTENT_VERSION_ID = '50000000-0000-4000-8000-000000000093';
const USER_ID = '60000000-0000-4000-8000-000000000093';
const ARTIFACT_ID = '70000000-0000-4000-8000-000000000093';
const SIGNED_URL = 'https://storage.example.test/exports/job-93.zip?signature=opaque';

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    { name: 'geo_csrf', url: 'http://127.0.0.1:34123', value: 'z'.repeat(43) },
  ]);
  await mockRole(page, 'publisher');
});

test('retries idempotently and preserves prior attempts while appending the next attempt', async ({
  page,
}) => {
  let currentJob = job({ attemptCount: 2, status: 'failed', version: 1 });
  let currentAttempts = [attempt(1, 'failed'), attempt(2, 'unknown')];
  const writes: { body: unknown; headers: Record<string, string>; path: string }[] = [];
  await page.route(`**/api/v1/publish-jobs/${JOB_ID}**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      await json(route, detail(currentJob, currentAttempts));
      return;
    }
    writes.push({
      body: request.postData() ? (request.postDataJSON() as unknown) : null,
      headers: request.headers(),
      path,
    });
    currentJob = job({ attemptCount: 3, status: 'scheduled', version: 2 });
    currentAttempts = [...currentAttempts, attempt(3, 'running')];
    await json(route, { data: currentJob, meta: { request_id: 'publish-retry' } });
  });

  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`/pub-03?id=${JOB_ID}`);
  await expect(page.locator('[data-attempt]')).toHaveCount(2);
  await expect(page.locator('[data-attempt="1"]')).toContainText('a'.repeat(64));
  await expect(page.locator('[data-attempt="2"]')).toContainText('b'.repeat(64));
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByText('发布重试已排队。')).toBeVisible();
  await expect(page.getByRole('heading', { name: '已排期' })).toBeVisible();
  await expect(page.locator('[data-attempt]')).toHaveCount(3);
  await expect(page.locator('[data-attempt="1"]')).toContainText('a'.repeat(64));
  await expect(page.locator('[data-attempt="2"]')).toContainText('b'.repeat(64));
  await expect(page.locator('[data-attempt="3"]')).toContainText('c'.repeat(64));

  expect(writes).toHaveLength(1);
  expect(writes[0]?.path).toBe(`/api/v1/publish-jobs/${JOB_ID}/retry`);
  expect(writes[0]?.body).toEqual({});
  expect(writes[0]?.headers['if-match']).toBe('"1"');
  expect(writes[0]?.headers['idempotency-key']).toMatch(
    new RegExp(`^publish-retry-${JOB_ID}-[0-9a-f-]{36}$`, 'u'),
  );
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

test('cancels only an unexecuted scheduled task with optimistic versioning', async ({ page }) => {
  let currentJob = job({ attemptCount: 0, status: 'scheduled', version: 4 });
  const writes: { body: unknown; headers: Record<string, string> }[] = [];
  await page.route(`**/api/v1/publish-jobs/${JOB_ID}**`, async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await json(route, detail(currentJob, []));
      return;
    }
    writes.push({ body: request.postDataJSON() as unknown, headers: request.headers() });
    currentJob = job({ attemptCount: 0, status: 'cancelled', version: 5 });
    await json(route, { data: currentJob, meta: { request_id: 'publish-cancel' } });
  });

  await page.goto(`/pub-03?id=${JOB_ID}`);
  page.once('dialog', (dialog) => dialog.accept('排期撤销'));
  await page.getByRole('button', { name: '取消未执行任务' }).click();
  await expect(page.getByText('未执行任务已取消。')).toBeVisible();
  await expect(page.getByRole('heading', { name: '已取消' })).toBeVisible();
  await expect(page.getByRole('button', { name: '取消未执行任务' })).toHaveCount(0);
  expect(writes).toHaveLength(1);
  expect(writes[0]?.body).toEqual({ reason: '排期撤销' });
  expect(writes[0]?.headers['if-match']).toBe('"4"');
  expect(writes[0]?.headers['idempotency-key']).toBeUndefined();
});

test('shows post result and obtains a short-lived signed export URL', async ({ page }) => {
  let exportRequests = 0;
  const published = job({ attemptCount: 1, status: 'published', version: 3 });
  await page.route(`**/api/v1/publish-jobs/${JOB_ID}**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/export')) {
      exportRequests += 1;
      await json(route, {
        data: {
          artifact_id: ARTIFACT_ID,
          content_hash: 'd'.repeat(64),
          content_version_id: CONTENT_VERSION_ID,
          expires_at: '2026-07-16T03:15:00.000Z',
          url: SIGNED_URL,
        },
        meta: { request_id: 'signed-export' },
      });
      return;
    }
    await json(route, detail(published, [attempt(1, 'succeeded')], artifact()));
  });

  await page.goto(`/pub-03?id=${JOB_ID}`);
  await expect(page.getByText('external-post-93')).toBeHidden();
  await expect(
    page.getByRole('link', { name: 'https://platform.example.test/posts/93' }),
  ).toHaveAttribute('rel', 'noopener noreferrer');
  await page.getByRole('button', { name: '下载导出' }).click();
  await expect(page.getByText('导出包下载地址已生成，请在有效期内使用。')).toBeVisible();
  await expect(page.getByRole('link', { name: '开始下载' })).toHaveAttribute('href', SIGNED_URL);
  expect(exportRequests).toBe(1);
});

test('denies non-publisher roles before requesting job data', async ({ page }) => {
  let detailRequests = 0;
  await page.unroute('**/api/v1/auth/tenants');
  await mockRole(page, 'viewer');
  await page.route(`**/api/v1/publish-jobs/${JOB_ID}**`, async (route) => {
    detailRequests += 1;
    await route.abort();
  });

  await page.goto(`/pub-03?id=${JOB_ID}`);
  await expect(page.getByRole('heading', { name: '无权查看发布任务' })).toBeVisible();
  expect(detailRequests).toBe(0);
});

function detail(
  currentJob: Record<string, unknown>,
  attempts: readonly Record<string, unknown>[],
  exportArtifact: Record<string, unknown> | null = null,
) {
  return {
    data: { attempts, export_artifact: exportArtifact, job: currentJob },
    meta: { request_id: 'publish-detail' },
  };
}

function job({
  attemptCount,
  status,
  version,
}: {
  attemptCount: number;
  status: string;
  version: number;
}) {
  return {
    account_id: ACCOUNT_ID,
    attempt_count: attemptCount,
    content_version_id: CONTENT_VERSION_ID,
    created_at: '2026-07-16T00:00:00.000Z',
    created_by: USER_ID,
    external_post_id: status === 'published' ? 'external-post-93' : null,
    external_url: status === 'published' ? 'https://platform.example.test/posts/93' : null,
    id: JOB_ID,
    idempotency_key: 'publish-job-00000093',
    last_error: status === 'failed' ? { code: 'RATE_LIMITED', retryable: true } : null,
    origin: 'manual',
    payload_hash: '9'.repeat(64),
    published_at: null,
    scheduled_at: '2026-07-16T02:00:00.000Z',
    status,
    tenant_id: TENANT_ID,
    updated_at: '2026-07-16T02:05:00.000Z',
    variant_id: VARIANT_ID,
    version,
  };
}

function attempt(number: number, status: string) {
  return {
    adapter_code: 'official-site-api@1',
    attempt_no: number,
    created_at: `2026-07-16T02:0${number}:00.000Z`,
    error_code: status === 'failed' ? 'RATE_LIMITED' : null,
    finished_at: status === 'running' ? null : `2026-07-16T02:0${number}:30.000Z`,
    id: `${80000000 + number * 1000000}-0000-4000-8000-000000000093`,
    publish_job_id: JOB_ID,
    request_hash: String.fromCharCode(96 + number).repeat(64),
    response: null,
    started_at: `2026-07-16T02:0${number}:00.000Z`,
    status,
    tenant_id: TENANT_ID,
  };
}

function artifact() {
  return {
    content_hash: 'd'.repeat(64),
    content_version_id: CONTENT_VERSION_ID,
    created_at: '2026-07-16T02:10:00.000Z',
    created_by: USER_ID,
    expires_at: '2026-08-16T02:10:00.000Z',
    id: ARTIFACT_ID,
    manifest: { format: 'zip', schema_version: 'export-manifest@1' },
    publish_job_id: JOB_ID,
    tenant_id: TENANT_ID,
    variant_id: VARIANT_ID,
  };
}

async function mockRole(page: Page, role: string) {
  await page.route('**/api/v1/auth/tenants', (route) =>
    json(route, {
      data: [
        {
          id: TENANT_ID,
          is_active: true,
          last_used_at: null,
          name: '发布企业',
          role_code: role,
          slug: 'publisher',
        },
      ],
      meta: { request_id: 'publish-role' },
    }),
  );
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}
