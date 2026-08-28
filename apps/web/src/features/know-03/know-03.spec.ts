import { expect, test } from '@playwright/test';

const sourceId = '10000000-0000-4000-8000-000000000080';
const tenantId = '20000000-0000-4000-8000-000000000080';
const workspaceId = '30000000-0000-4000-8000-000000000080';
const projectId = '40000000-0000-4000-8000-000000000080';
const chunkId = '50000000-0000-4000-8000-000000000080';
const jobId = '60000000-0000-4000-8000-000000000080';
const newJobId = '70000000-0000-4000-8000-000000000080';
const pageUrl = `/know-03?id=${sourceId}&workspace_id=${workspaceId}&project_id=${projectId}`;

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([{ name: 'geo_csrf', url: 'http://127.0.0.1:34110', value: 'csrf' }]);
  await page.route('**/api/v1/auth/tenants', async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        data: [
          {
            id: tenantId,
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
    });
  });
  await page.route(`**/api/v1/sources/${sourceId}?*`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      body: JSON.stringify(detailResponse()),
      contentType: 'application/json',
      status: 200,
    });
  });
});

test('shows the original text and keeps traceability identifiers in technical details', async ({
  page,
}) => {
  await page.goto(pageUrl);
  await expect(page.getByRole('heading', { name: '产品白皮书' })).toBeVisible();
  await expect(page.getByText(`资料编号：${sourceId}`)).toBeHidden();
  const chunk = page.getByRole('listitem').filter({ hasText: '第 1 段' });
  await expect(chunk.getByText('产品 X 将于 2026 年发布。')).toBeVisible();
  await expect(chunk.getByText('第 2 页，字符 120-137')).toBeVisible();
  await chunk.getByText('片段技术信息').click();
  await expect(chunk.getByText(sourceId)).toBeVisible();
  await expect(chunk.getByText(`文本校验值：${'b'.repeat(64)}`)).toBeVisible();
});

test('shows certificate verification fields and publication authorization', async ({ page }) => {
  await page.route(`**/api/v1/sources/${sourceId}?*`, async (route) => {
    const base = detailResponse();
    const response = {
      ...base,
      data: {
        ...base.data,
        certificate: {
          article_use_allowed: true,
          certificate_name: '道路运输经营许可证',
          certificate_number: '粤交运管许可字 2026-001',
          holder_name: '广州示例搬家服务有限公司',
          issuing_authority: '广州市交通运输局',
          public_display_confirmed: true,
          schema_version: 'source-certificate@1',
          verification_url: 'https://example.gov.cn/verify/2026-001',
        },
        source: { ...base.data.source, mime_type: 'image/png', source_type: 'image' },
      },
    };
    await route.fulfill({
      body: JSON.stringify(response),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.goto(pageUrl);
  await expect(page.getByText('企业证照')).toBeVisible();
  await expect(page.getByText('粤交运管许可字 2026-001')).toBeVisible();
  await expect(page.getByText('已授权（仅正文引用时）')).toBeVisible();
  await expect(page.getByRole('link', { name: '打开官方核验链接' })).toHaveAttribute(
    'href',
    'https://example.gov.cn/verify/2026-001',
  );
});

test('shows only the insurance proof summary and marks the original as private', async ({
  page,
}) => {
  await page.route(`**/api/v1/sources/${sourceId}?*`, async (route) => {
    const base = detailResponse();
    await route.fulfill({
      body: JSON.stringify({
        ...base,
        data: {
          ...base.data,
          chunks: [
            {
              ...base.data.chunks[0],
              metadata: { char_end: 120, char_start: 0, schema_version: 'chunk-metadata@1' },
              text: '资料类型：企业保险证明\n投保主体：广州示例搬家服务有限公司',
            },
          ],
          insurance_proof: {
            insurance_type: '团体员工福利保险',
            insured_count: 11,
            insurer_name: '示例人寿保险有限公司',
            policyholder_name: '广州示例搬家服务有限公司',
            schema_version: 'source-insurance-proof@1',
            summary_use_confirmed: true,
          },
          source: {
            ...base.data.source,
            effective_from: '2026-01-10',
            effective_to: '2027-01-09',
            title: '企业保险证明',
          },
        },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.goto(pageUrl);
  await expect(page.getByText('保险证明').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: '保险证明脱敏摘要' })).toBeVisible();
  await expect(page.getByText('广州示例搬家服务有限公司', { exact: true })).toBeVisible();
  await expect(page.getByText('2026-01-10 — 2027-01-09').last()).toBeVisible();
  await expect(page.getByText('禁止')).toBeVisible();
  await expect(page.getByRole('heading', { name: '可检索脱敏摘要' })).toBeVisible();
});

test('retries parsing with exact source hash and expires with current revision', async ({
  page,
}) => {
  let retryBody: Record<string, unknown> | undefined;
  let expireHeaders: Record<string, string> | undefined;
  await page.route(`**/api/v1/sources/${sourceId}/reindex`, async (route) => {
    retryBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      body: JSON.stringify({ data: job(newJobId, 'queued'), meta: { request_id: 'retry' } }),
      contentType: 'application/json',
      status: 202,
    });
  });
  await page.route(`**/api/v1/sources/${sourceId}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    expireHeaders = route.request().headers();
    await route.fulfill({ status: 204 });
  });
  await page.goto(pageUrl);
  await page.getByRole('button', { name: '重试解析' }).click();
  await expect(page.getByText('已重新开始处理资料，稍后刷新页面可查看进度。')).toBeVisible();
  await expect(page.getByText(newJobId)).toHaveCount(0);
  expect(retryBody).toMatchObject({ expected_content_hash: 'a'.repeat(64) });
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '标记失效' }).click();
  await expect(page.getByText('资料已失效，不会进入新的检索。')).toBeVisible();
  expect(expireHeaders?.['if-match']).toBe('"2026-07-15T01:00:00.000Z"');
});

test('updates the source validity with the current revision and refreshes the visible range', async ({
  page,
}) => {
  let body: Record<string, unknown> | undefined;
  let headers: Record<string, string> | undefined;
  await page.route(`**/api/v1/sources/${sourceId}/validity`, async (route) => {
    body = route.request().postDataJSON() as Record<string, unknown>;
    headers = route.request().headers();
    await route.fulfill({
      body: JSON.stringify({
        data: {
          ...source(),
          effective_from: '2026-08-01',
          effective_to: '2027-07-31',
          updated_at: '2026-08-28T08:00:00.000Z',
        },
        meta: { request_id: 'validity' },
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.goto(pageUrl);
  await page.getByRole('button', { name: '修改有效期' }).click();
  await page.getByLabel('有效期开始').fill('2026-08-01');
  await page.getByLabel('有效期结束').fill('2027-07-31');
  await page.getByRole('button', { name: '保存有效期' }).click();
  await expect(page.getByText('2026-08-01 — 2027-07-31')).toBeVisible();
  await expect(
    page.getByText('有效期已更新，新检索将立即按修正后的日期判断资料是否有效。'),
  ).toBeVisible();
  expect(body).toEqual({
    effective_from: '2026-08-01',
    effective_to: '2027-07-31',
    reason: '用户从资料详情修正有效期',
  });
  expect(headers?.['if-match']).toBe('"2026-07-15T01:00:00.000Z"');
});

test('shows metadata, parse logs, facts and citation count on mobile without viewer writes', async ({
  page,
}) => {
  await page.route('**/api/v1/auth/tenants', async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        data: [
          {
            id: tenantId,
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
    });
  });
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(pageUrl);
  await expect(page.getByText('PDF 文档')).toBeVisible();
  await expect(page.getByText('引用次数').locator('..').getByText('3')).toBeVisible();
  await expect(page.getByText('完成 · 100%')).toBeVisible();
  await expect(page.getByText('处理完成 · 第 2 次处理')).toBeVisible();
  await expect(page.getByText('产品 X · 发布时间')).toBeVisible();
  await expect(page.getByRole('button', { name: '重试解析' })).toHaveCount(0);
  await expect(page.locator('main')).toHaveCSS('min-height', '844px');
});

function detailResponse() {
  return {
    data: {
      chunks: [
        {
          chunk_no: 0,
          created_at: '2026-07-15T00:30:00.000Z',
          id: chunkId,
          metadata: { char_end: 137, char_start: 120, page: 2, schema_version: 'chunk-metadata@1' },
          source_document_id: sourceId,
          status: 'active',
          text: '产品 X 将于 2026 年发布。',
          text_hash: 'b'.repeat(64),
          token_count: 12,
        },
      ],
      citation_count: 3,
      facts: [
        {
          confidence: 0.95,
          created_at: '2026-07-15T00:40:00.000Z',
          evidence: [],
          id: '80000000-0000-4000-8000-000000000080',
          object_value: '2026',
          predicate: '发布时间',
          status: 'verified',
          subject: '产品 X',
          tenant_id: tenantId,
          unit: '年',
          updated_at: '2026-07-15T00:50:00.000Z',
          valid_from: null,
          valid_to: null,
          workspace_id: workspaceId,
        },
      ],
      ingest_jobs: [job(jobId, 'succeeded')],
      source: source(),
    },
    meta: { request_id: 'detail' },
  };
}

function source() {
  return {
    content_hash: 'a'.repeat(64),
    created_at: '2026-07-15T00:00:00.000Z',
    created_by: '90000000-0000-4000-8000-000000000080',
    effective_from: '2026-01-01',
    effective_to: null,
    id: sourceId,
    language: 'zh-CN',
    mime_type: 'application/pdf',
    project_id: projectId,
    source_type: 'pdf',
    status: 'active',
    tenant_id: tenantId,
    title: '产品白皮书',
    trust_level: 'verified',
    updated_at: '2026-07-15T01:00:00.000Z',
    workspace_id: workspaceId,
  };
}

function job(id: string, status: 'queued' | 'succeeded') {
  return {
    attempt_count: status === 'queued' ? 0 : 1,
    created_at: '2026-07-15T00:00:00.000Z',
    error: null,
    finished_at: status === 'succeeded' ? '2026-07-15T00:20:00.000Z' : null,
    id,
    progress: status === 'succeeded' ? 100 : 0,
    source_document_id: sourceId,
    stage: status === 'succeeded' ? 'done' : 'queued',
    started_at: status === 'succeeded' ? '2026-07-15T00:01:00.000Z' : null,
    status,
    tenant_id: tenantId,
    updated_at: '2026-07-15T00:20:00.000Z',
  };
}
