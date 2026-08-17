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
  let currentAttempts = [attempt(1, 'failed'), attempt(2, 'failed')];
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
  await expect(page.getByRole('button', { name: '重新排期' })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]?.body).toEqual({ reason: '排期撤销' });
  expect(writes[0]?.headers['if-match']).toBe('"4"');
  expect(writes[0]?.headers['idempotency-key']).toBeUndefined();
});

test('requires manual verification before retrying an unknown Baijiahao publication', async ({
  page,
}) => {
  let currentJob: Record<string, unknown> = {
    ...job({ attemptCount: 4, status: 'failed', version: 12 }),
    last_error: { code: 'PUBLISH_STATE_UNKNOWN' },
  };
  const currentAttempts = [{ ...attempt(4, 'unknown'), adapter_code: 'baijiahao-delivery@1.1.0' }];
  let unknownResolution: Record<string, unknown> | null = {
    can_retry: true,
    latest_attempt_no: 4,
    platform_code: 'baijiahao',
  };
  const writes: { body: unknown; headers: Record<string, string>; path: string }[] = [];
  await page.route(`**/api/v1/publish-jobs/${JOB_ID}**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      await json(route, detail(currentJob, currentAttempts, null, unknownResolution));
      return;
    }
    writes.push({ body: request.postDataJSON() as unknown, headers: request.headers(), path });
    currentJob = job({ attemptCount: 4, status: 'scheduled', version: 13 });
    unknownResolution = null;
    await json(route, { data: currentJob, meta: { request_id: 'unknown-resolved' } });
  });

  await page.goto(`/pub-03?id=${JOB_ID}`);
  await expect(page.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '确认未发布并重试' }).click();

  await expect(page.getByText('已确认平台未创建该文章，发布重试已排队。')).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]?.path).toBe(`/api/v1/publish-jobs/${JOB_ID}/resolve-unknown`);
  expect(writes[0]?.body).toEqual({ resolution: 'not_published' });
  expect(writes[0]?.headers['if-match']).toBe('"12"');
  expect(writes[0]?.headers['idempotency-key']).toMatch(
    new RegExp(`^publish-resolve-unknown-${JOB_ID}-[0-9a-f-]{36}$`, 'u'),
  );
});

test('routes a manual-required Baijiahao automation through verified resolution', async ({
  page,
}) => {
  const currentJob = {
    ...job({ attemptCount: 2, status: 'failed', version: 7 }),
    last_error: { code: 'MANUAL_REQUIRED' },
    origin: 'baijiahao_automation',
  };
  const currentAttempt = {
    ...attempt(2, 'failed'),
    adapter_code: 'baijiahao-delivery@1.1.0',
    error_code: 'MANUAL_REQUIRED',
  };
  const writes: { body: unknown; path: string }[] = [];
  await page.route(`**/api/v1/publish-jobs/${JOB_ID}**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      await json(
        route,
        detail(currentJob, [currentAttempt], null, {
          can_retry: true,
          latest_attempt_no: 2,
          platform_code: 'baijiahao',
        }),
      );
      return;
    }
    writes.push({ body: request.postDataJSON() as unknown, path });
    await json(route, {
      data: { ...currentJob, status: 'scheduled', version: 8 },
      meta: { request_id: 'manual-required-resolved' },
    });
  });

  await page.goto(`/pub-03?id=${JOB_ID}`);
  await expect(page.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
  await expect(page.getByText('百家号发布结果需要人工核实')).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '确认未发布并重试' }).click();

  expect(writes).toEqual([
    {
      body: { resolution: 'not_published' },
      path: `/api/v1/publish-jobs/${JOB_ID}/resolve-unknown`,
    },
  ]);
});

test('records a manually verified Baijiahao publication with its public link', async ({ page }) => {
  let currentJob: Record<string, unknown> = {
    ...job({ attemptCount: 4, status: 'failed', version: 12 }),
    last_error: { code: 'PUBLISH_STATE_UNKNOWN' },
  };
  let unknownResolution: Record<string, unknown> | null = {
    can_retry: true,
    latest_attempt_no: 4,
    platform_code: 'baijiahao',
  };
  const writes: { body: unknown; path: string }[] = [];
  await page.route(`**/api/v1/publish-jobs/${JOB_ID}**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      await json(route, detail(currentJob, [attempt(4, 'unknown')], null, unknownResolution));
      return;
    }
    writes.push({ body: request.postDataJSON() as unknown, path });
    currentJob = {
      ...job({ attemptCount: 4, status: 'published', version: 13 }),
      external_post_id: '123456',
      external_url: 'https://baijiahao.baidu.com/s?id=123456',
    };
    unknownResolution = null;
    await json(route, { data: currentJob, meta: { request_id: 'unknown-published' } });
  });

  await page.goto(`/pub-03?id=${JOB_ID}`);
  page.once('dialog', (dialog) => dialog.accept('https://baijiahao.baidu.com/s?id=123456'));
  await page.getByRole('button', { name: '确认已经发布' }).click();

  await expect(page.getByText('已按人工核实结果记录为已发布。')).toBeVisible();
  expect(writes).toEqual([
    {
      body: {
        external_post_id: '123456',
        external_url: 'https://baijiahao.baidu.com/s?id=123456',
        resolution: 'published',
      },
      path: `/api/v1/publish-jobs/${JOB_ID}/resolve-unknown`,
    },
  ]);
});

test('closes an exhausted Baijiahao task after it is verified as not published', async ({
  page,
}) => {
  let currentJob: Record<string, unknown> = {
    ...job({ attemptCount: 3, status: 'failed', version: 9 }),
    last_error: { code: 'MANUAL_REQUIRED' },
    origin: 'baijiahao_automation',
  };
  let unknownResolution: Record<string, unknown> | null = {
    can_retry: false,
    latest_attempt_no: 3,
    platform_code: 'baijiahao',
  };
  const writes: { body: unknown; path: string }[] = [];
  await page.route(`**/api/v1/publish-jobs/${JOB_ID}**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      await json(
        route,
        detail(
          currentJob,
          [
            {
              ...attempt(3, 'failed'),
              adapter_code: 'baijiahao-delivery@1.1.0',
              error_code: 'MANUAL_REQUIRED',
            },
          ],
          null,
          unknownResolution,
        ),
      );
      return;
    }
    writes.push({ body: request.postDataJSON() as unknown, path });
    currentJob = { ...currentJob, status: 'cancelled', version: 10 };
    unknownResolution = null;
    await json(route, { data: currentJob, meta: { request_id: 'not-published-closed' } });
  });

  await page.goto(`/pub-03?id=${JOB_ID}`);
  await expect(page.getByRole('button', { name: '确认未发布并重试' })).toHaveCount(0);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '确认未发布并结束任务' }).click();

  await expect(
    page.getByText('已确认平台未创建该文章，任务已结束且不会再次自动发布。'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: '已取消' })).toBeVisible();
  expect(writes).toEqual([
    {
      body: { resolution: 'not_published_closed' },
      path: `/api/v1/publish-jobs/${JOB_ID}/resolve-unknown`,
    },
  ]);
});

test('requeues Baijiahao reconciliation without retrying publication', async ({ page }) => {
  let currentJob: Record<string, unknown> = {
    ...job({ attemptCount: 2, status: 'publishing', version: 6 }),
    external_post_id: '1872934608584882031',
    external_url: 'https://baijiahao.baidu.com/s?id=1872934608584882031',
    origin: 'baijiahao_automation',
  };
  let reconciliation: Record<string, unknown> | null = { platform_code: 'baijiahao' };
  const writes: { body: unknown; headers: Record<string, string>; path: string }[] = [];
  await page.route(`**/api/v1/publish-jobs/${JOB_ID}**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      await json(route, detail(currentJob, [attempt(2, 'succeeded')], null, null, reconciliation));
      return;
    }
    writes.push({
      body: request.postDataJSON() as unknown,
      headers: request.headers(),
      path,
    });
    currentJob = { ...currentJob, version: 7 };
    reconciliation = null;
    await json(route, { data: currentJob, meta: { request_id: 'reconcile-requested' } });
  });

  await page.goto(`/pub-03?id=${JOB_ID}`);
  await page.getByRole('button', { name: '重新核验百家号状态' }).click();

  await expect(page.getByText('百家号发布状态核验已重新排队；不会再次提交文章。')).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]?.path).toBe(`/api/v1/publish-jobs/${JOB_ID}/reconcile`);
  expect(writes[0]?.body).toEqual({});
  expect(writes[0]?.headers['if-match']).toBe('"6"');
  expect(writes[0]?.headers['idempotency-key']).toMatch(
    new RegExp(`^publish-reconcile-${JOB_ID}-[0-9a-f-]{36}$`, 'u'),
  );
});

test('loads and labels a Baijiahao automation publish job', async ({ page }) => {
  const currentJob = {
    ...job({ attemptCount: 0, status: 'scheduled', version: 1 }),
    origin: 'baijiahao_automation',
  };
  await page.route(`**/api/v1/publish-jobs/${JOB_ID}**`, (route) =>
    json(route, detail(currentJob, [])),
  );

  await page.goto(`/pub-03?id=${JOB_ID}`);

  await expect(page.getByText('百家号自动化创建')).toBeVisible();
  await expect(page.getByRole('heading', { name: '无法加载发布任务' })).toHaveCount(0);
});

test('queues missing images for a scheduled job and follows progress to completion', async ({
  page,
}) => {
  const currentJob = job({ attemptCount: 0, status: 'scheduled', version: 4 });
  let media = { asset_count: 0, run_id: null as string | null, status: 'none', supported: true };
  let mediaWrites = 0;
  await page.route(`**/api/v1/publish-jobs/${JOB_ID}**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.endsWith('/media')) {
      mediaWrites += 1;
      expect(request.headers()['if-match']).toBe('"4"');
      expect(request.headers()['idempotency-key']).toMatch(
        new RegExp(`^publish-media-${JOB_ID}-[0-9a-f-]{36}$`, 'u'),
      );
      media = {
        asset_count: 0,
        run_id: '90000000-0000-4000-8000-000000000093',
        status: 'running',
        supported: true,
      };
      await json(route, {
        data: { id: media.run_id, status: 'queued' },
        meta: { request_id: 'publish-media' },
      });
      return;
    }
    if (request.method() === 'GET' && media.status === 'running') {
      media = { ...media, asset_count: 3, status: 'ready' };
    }
    await json(route, {
      ...detail(currentJob, []),
      data: { ...detail(currentJob, []).data, media },
    });
  });

  await page.goto(`/pub-03?id=${JOB_ID}`);
  await page.getByRole('button', { name: '生成配图' }).click();
  await expect(page.getByText('已生成 3 张配图，将随文章一起发布。')).toBeVisible();
  expect(mediaWrites).toBe(1);
});

test('restores a cancelled task by rescheduling the same publish job', async ({ page }) => {
  let currentJob = job({ attemptCount: 0, status: 'cancelled', version: 5 });
  const writes: { body: unknown; headers: Record<string, string>; path: string }[] = [];
  await page.route(`**/api/v1/publish-jobs/${JOB_ID}**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      await json(route, detail(currentJob, []));
      return;
    }
    const body = request.postDataJSON() as { scheduled_at: string };
    writes.push({ body, headers: request.headers(), path });
    currentJob = {
      ...currentJob,
      scheduled_at: body.scheduled_at,
      status: 'scheduled',
      version: 6,
    };
    await json(route, { data: currentJob, meta: { request_id: 'publish-reschedule' } });
  });

  await page.goto(`/pub-03?id=${JOB_ID}`);
  page.once('dialog', (dialog) => dialog.accept('2026-07-21T10:30'));
  await page.getByRole('button', { name: '重新排期' }).click();

  await expect(page.getByText('发布任务已重新排期。')).toBeVisible();
  await expect(page.getByRole('heading', { name: '已排期' })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]?.path).toBe(`/api/v1/publish-jobs/${JOB_ID}/retry`);
  expect(writes[0]?.body).toEqual({ scheduled_at: '2026-07-21T02:30:00.000Z' });
  expect(writes[0]?.headers['if-match']).toBe('"5"');
  expect(writes[0]?.headers['idempotency-key']).toMatch(
    new RegExp(`^publish-retry-${JOB_ID}-[0-9a-f-]{36}$`, 'u'),
  );
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
  unknownResolution: Record<string, unknown> | null = null,
  baijiahaoReconciliation: Record<string, unknown> | null = null,
) {
  return {
    data: {
      attempts,
      baijiahao_reconciliation: baijiahaoReconciliation,
      export_artifact: exportArtifact,
      job: currentJob,
      media: { asset_count: 0, run_id: null, status: 'none', supported: true },
      unknown_resolution: unknownResolution,
    },
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
