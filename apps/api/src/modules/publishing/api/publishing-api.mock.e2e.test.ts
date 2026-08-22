import 'reflect-metadata';

import {
  findPublishingApiContract,
  type BrowserPlatformAutomationPolicyView,
  type OfficialSiteAutomationPolicyView,
  type PublishAttemptView,
  type PublishJobDetail,
  type PublishJobView,
  type SignedDownloadView,
} from '@geo-content-os/contracts';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { IdempotencyService } from '../../../common/idempotency/index.js';
import { PolicyGuard, setPolicyContext } from '../../identity/rbac/index.js';
import {
  BaijiahaoAutomationPolicyService,
  BrowserPlatformAutomationPolicyService,
  OfficialSiteAutomationPolicyService,
  PlatformAccountError,
  PlatformAccountService,
  LiejuBrowserSessionService,
  SohuBrowserSessionService,
} from '../accounts/index.js';
import { PublishJobService } from '../jobs/index.js';
import { PlatformAccountController, PublishJobController } from './publishing-api.controller.js';
import { PublishingApiService } from './publishing-api.service.js';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const USER_ID = '10000000-0000-4000-8000-000000000002';
const JOB_ID = '10000000-0000-4000-8000-000000000003';
const VARIANT_ID = '10000000-0000-4000-8000-000000000004';
const CONTENT_VERSION_ID = '10000000-0000-4000-8000-000000000005';
const ACCOUNT_ID = '10000000-0000-4000-8000-000000000006';
const ATTEMPT_ID = '10000000-0000-4000-8000-000000000007';
const ARTIFACT_ID = '10000000-0000-4000-8000-000000000008';
const REQUEST_ID = '10000000-0000-4000-8000-000000000009';
const MEDIA_RUN_ID = '10000000-0000-4000-8000-000000000013';
const PROJECT_ID = '10000000-0000-4000-8000-000000000010';
const POLICY_ID = '10000000-0000-4000-8000-000000000011';
const NOW = '2026-07-16T08:00:00.000Z';

const job: PublishJobView = {
  account_id: ACCOUNT_ID,
  attempt_count: 1,
  content_version_id: CONTENT_VERSION_ID,
  created_at: NOW,
  created_by: USER_ID,
  external_post_id: null,
  external_url: null,
  id: JOB_ID,
  idempotency_key: 'publish-job-0001',
  last_error: null,
  origin: 'manual',
  payload_hash: 'a'.repeat(64),
  published_at: null,
  scheduled_at: NOW,
  status: 'scheduled',
  tenant_id: TENANT_ID,
  updated_at: NOW,
  variant_id: VARIANT_ID,
  version: 3,
};

const attempt: PublishAttemptView = {
  adapter_code: 'official_site.delivery',
  attempt_no: 1,
  created_at: NOW,
  error_code: null,
  finished_at: NOW,
  id: ATTEMPT_ID,
  publish_job_id: JOB_ID,
  request_hash: 'b'.repeat(64),
  response: { accepted: true },
  started_at: NOW,
  status: 'succeeded',
  tenant_id: TENANT_ID,
};

const detail: PublishJobDetail = {
  attempts: [attempt],
  baijiahao_reconciliation: null,
  content_snapshot: {
    content: {
      blocks: [{ block_key: 'intro', block_type: 'paragraph', text: '发布正文。' }],
      citation_map: [],
      cta: null,
      hashtags: [],
      platform_code: 'official_site',
      platform_meta: {},
      schema_version: 'content-writer-data@1',
      summary: '发布摘要。',
      title: '发布内容标题',
    },
    content_hash: job.payload_hash,
    content_version_id: CONTENT_VERSION_ID,
  },
  export_artifact: {
    content_hash: 'c'.repeat(64),
    content_version_id: CONTENT_VERSION_ID,
    created_at: NOW,
    created_by: USER_ID,
    expires_at: '2026-07-17T08:00:00.000Z',
    id: ARTIFACT_ID,
    manifest: { file_count: 2 },
    publish_job_id: JOB_ID,
    tenant_id: TENANT_ID,
    variant_id: VARIANT_ID,
  },
  job,
  media: { asset_count: 0, run_id: null, status: 'none', supported: true },
  unknown_resolution: null,
};

const download: SignedDownloadView = {
  artifact_id: ARTIFACT_ID,
  content_hash: 'c'.repeat(64),
  content_version_id: CONTENT_VERSION_ID,
  expires_at: '2026-07-16T08:15:00.000Z',
  url: 'https://storage.example.test/signed/export.zip',
};

const automationPolicy: OfficialSiteAutomationPolicyView = {
  account_id: ACCOUNT_ID,
  brand_consistency_min: 90,
  daily_candidate_limit: 30,
  daily_enabled: true,
  daily_generation_time: '00:00:00',
  daily_schedule_times: [
    '08:00:00',
    '09:30:00',
    '11:00:00',
    '12:30:00',
    '14:00:00',
    '15:30:00',
    '17:00:00',
    '18:30:00',
    '20:00:00',
    '21:30:00',
  ],
  daily_target_count: 10,
  daily_timezone: 'Asia/Shanghai',
  enabled: true,
  factual_accuracy_min: 90,
  geo_total_min: 85,
  id: POLICY_ID,
  max_rewrites: 3,
  platform_fit_min: 80,
  project_id: PROJECT_ID,
  publish_attempt_limit: 3,
  question_coverage_min: 80,
  readability_safety_min: 85,
  tenant_id: TENANT_ID,
  today_batch: {
    attempt_no: 2,
    attempted_count: 0,
    business_date: '2026-07-27',
    in_progress_count: 0,
    last_error_message: null,
    published_count: 0,
    queued_count: 0,
    qualified_count: 0,
    restart_allowed: false,
    retired_count: 0,
    running_count: 0,
    scheduled_count: 0,
    status: 'running',
    target_count: 10,
    version: 1,
  },
  updated_at: NOW,
  version: 1,
  workspace_id: '10000000-0000-4000-8000-000000000012',
};

const browserAutomationPolicy: BrowserPlatformAutomationPolicyView = {
  account_id: ACCOUNT_ID,
  brand_consistency_min: 90,
  daily_candidate_limit: 3,
  daily_enabled: true,
  daily_generation_time: '00:30:00',
  daily_schedule_times: ['10:00:00'],
  daily_target_count: 1,
  daily_timezone: 'Asia/Shanghai',
  enabled: true,
  factual_accuracy_min: 90,
  geo_total_min: 85,
  id: POLICY_ID,
  max_rewrites: 3,
  platform_code: 'lieju',
  platform_fit_min: 80,
  project_id: PROJECT_ID,
  publish_attempt_limit: 3,
  question_coverage_min: 80,
  readability_safety_min: 85,
  tenant_id: TENANT_ID,
  today_batch: {
    attempt_no: 1,
    attempted_count: 0,
    business_date: '2026-08-17',
    in_progress_count: 0,
    last_error_message: null,
    manual_items: [],
    manual_required_count: 0,
    published_count: 0,
    restart_allowed: false,
    retired_count: 0,
    retry_allowed: false,
    scheduled_count: 0,
    status: 'running',
    target_count: 1,
    version: 2,
  },
  updated_at: NOW,
  version: 1,
  workspace_id: '10000000-0000-4000-8000-000000000012',
};

describe('publishing API mock E2E', () => {
  let application: NestFastifyApplication;
  const listJobs = vi.fn(async () => ({ items: [job], nextCursor: 'next-page' }));
  const api = {
    attempts: vi.fn(async () => [attempt]),
    detail: vi.fn(async () => detail),
    listJobs,
    requestMedia: vi.fn(async () => ({ id: MEDIA_RUN_ID, status: 'queued' as const })),
    signedExport: vi.fn(async () => download),
  };
  const jobs = {
    cancel: vi.fn(async () => ({ ...job, status: 'cancelled' as const, version: 4 })),
    createInTransaction: vi.fn(async () => job),
    requestBaijiahaoReconciliationInTransaction: vi.fn(async () => ({ ...job, version: 4 })),
    resolveUnknownInTransaction: vi.fn(async () => ({
      ...job,
      scheduled_at: NOW,
      status: 'scheduled' as const,
      version: 4,
    })),
    retryInTransaction: vi.fn(async () => job),
  };
  const automation = {
    cancelDailyBatchInTransaction: vi.fn(async () => ({
      ...automationPolicy,
      today_batch: {
        ...automationPolicy.today_batch!,
        in_progress_count: 0,
        last_error_message: '今日批次已由用户手动终止，不再生成新候选或自动排期。',
        queued_count: 0,
        running_count: 0,
        status: 'cancelled' as const,
        version: 2,
      },
    })),
    restartDailyBatchInTransaction: vi.fn(async () => automationPolicy),
  };
  const baijiahaoAutomation = {
    restartDailyBatchInTransaction: vi.fn(),
    startLogin: vi.fn(),
  };
  const browserPlatformAutomation = {
    list: vi.fn(async () => []),
    restartDailyBatchInTransaction: vi.fn(async () => browserAutomationPolicy),
    retryDailyBatchInTransaction: vi.fn(async () => browserAutomationPolicy),
    update: vi.fn(),
  };
  const sohuBrowser = {
    login: vi.fn(),
    reauthenticate: vi.fn(),
    status: vi.fn(),
  };
  const liejuBrowser = {
    login: vi.fn(),
    reauthenticate: vi.fn(),
    status: vi.fn(),
  };
  const idempotency = {
    execute: vi.fn(
      async (
        _input: unknown,
        operation: (transaction: Readonly<Record<string, never>>) => Promise<unknown>,
      ) => ({ replayed: false, response: await operation({}) }),
    ),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PlatformAccountController, PublishJobController],
      providers: [
        { provide: IdempotencyService, useValue: idempotency },
        { provide: BaijiahaoAutomationPolicyService, useValue: baijiahaoAutomation },
        { provide: BrowserPlatformAutomationPolicyService, useValue: browserPlatformAutomation },
        { provide: OfficialSiteAutomationPolicyService, useValue: automation },
        { provide: PlatformAccountService, useValue: {} },
        { provide: PublishJobService, useValue: jobs },
        { provide: PublishingApiService, useValue: api },
        { provide: SohuBrowserSessionService, useValue: sohuBrowser },
        { provide: LiejuBrowserSessionService, useValue: liejuBrowser },
      ],
    })
      .overrideGuard(PolicyGuard)
      .useValue(new MockPublishingGuard())
      .compile();
    application = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => REQUEST_ID }),
    );
    await application.init();
    await application.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => application?.close());

  it('serves the publishing calendar from the filtered job-list endpoint', async () => {
    const response = await application.inject({
      method: 'GET',
      url: `/publish-jobs?from=2026-07-16T00%3A00%3A00.000Z&to=2026-07-17T00%3A00%3A00.000Z&platform_code=official_site&account_id=${ACCOUNT_ID}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    findPublishingApiContract('job.list').responseSchema.parse(body);
    expect(body.meta.next_cursor).toBe('next-page');
    expect(listJobs).toHaveBeenCalledWith(
      { tenantId: TENANT_ID, userId: USER_ID },
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        limit: 50,
        platform_code: 'official_site',
      }),
    );
  });

  it('lists browser-platform automation policies for an account', async () => {
    const response = await application.inject({
      method: 'GET',
      url: `/platform-accounts/${ACCOUNT_ID}/content-automation`,
    });

    expect(response.statusCode).toBe(200);
    findPublishingApiContract('account.browser_platform_automation.list').responseSchema.parse(
      response.json(),
    );
    expect(browserPlatformAutomation.list).toHaveBeenCalledWith(
      { tenantId: TENANT_ID, userId: USER_ID },
      ACCOUNT_ID,
    );
  });

  it('retries an empty prerequisite-blocked browser-platform batch idempotently', async () => {
    const response = await application.inject({
      headers: { 'idempotency-key': 'browser-platform-daily-retry-0001' },
      method: 'POST',
      payload: { expected_batch_version: 1, project_id: PROJECT_ID },
      url: `/platform-accounts/${ACCOUNT_ID}/content-automation/daily-batch/retry`,
    });

    expect(response.statusCode).toBe(200);
    findPublishingApiContract(
      'account.browser_platform_automation.daily_batch.retry',
    ).responseSchema.parse(response.json());
    expect(browserPlatformAutomation.retryDailyBatchInTransaction).toHaveBeenCalledWith(
      {},
      { tenantId: TENANT_ID, userId: USER_ID },
      ACCOUNT_ID,
      { expected_batch_version: 1, project_id: PROJECT_ID },
      expect.objectContaining({ requestId: REQUEST_ID }),
    );
    expect(idempotency.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        fingerprint: expect.objectContaining({
          path: `/platform-accounts/${ACCOUNT_ID}/content-automation/daily-batch/retry`,
        }),
        idempotencyKey: 'browser-platform-daily-retry-0001',
      }),
      expect.any(Function),
    );
  });

  it('returns the aggregate detail and append-only attempts', async () => {
    const detailResponse = await application.inject({
      method: 'GET',
      url: `/publish-jobs/${JOB_ID}`,
    });
    const attemptResponse = await application.inject({
      method: 'GET',
      url: `/publish-jobs/${JOB_ID}/attempts`,
    });

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.headers.etag).toBe('"3"');
    findPublishingApiContract('job.get').responseSchema.parse(detailResponse.json());
    expect(attemptResponse.statusCode).toBe(200);
    findPublishingApiContract('job.attempts').responseSchema.parse(attemptResponse.json());
  });

  it('returns a short-lived export URL without exposing credentials', async () => {
    const response = await application.inject({
      method: 'GET',
      url: `/publish-jobs/${JOB_ID}/export`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    findPublishingApiContract('job.export').responseSchema.parse(body);
    expect(JSON.stringify(body)).not.toMatch(/credential|ciphertext|access_token/iu);
  });

  it('enforces idempotency and optimistic version headers on job writes', async () => {
    const createResponse = await application.inject({
      headers: { 'idempotency-key': 'publish-job-create-0001' },
      method: 'POST',
      payload: { account_id: ACCOUNT_ID, scheduled_at: NOW, variant_id: VARIANT_ID },
      url: '/publish-jobs',
    });
    const cancelResponse = await application.inject({
      headers: { 'if-match': '"3"' },
      method: 'POST',
      payload: { reason: 'Editorial calendar changed' },
      url: `/publish-jobs/${JOB_ID}/cancel`,
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.headers.etag).toBe('"3"');
    findPublishingApiContract('job.create').responseSchema.parse(createResponse.json());
    expect(jobs.createInTransaction).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ tenantId: TENANT_ID, userId: USER_ID }),
      expect.objectContaining({ account_id: ACCOUNT_ID, variant_id: VARIANT_ID }),
      'publish-job-create-0001',
    );
    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.headers.etag).toBe('"4"');
    findPublishingApiContract('job.cancel').responseSchema.parse(cancelResponse.json());
    expect(jobs.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, userId: USER_ID }),
      JOB_ID,
      3,
      'Editorial calendar changed',
    );
  });

  it('queues image generation for a versioned scheduled job', async () => {
    const response = await application.inject({
      headers: { 'idempotency-key': 'publish-media-0001', 'if-match': '"3"' },
      method: 'POST',
      payload: {},
      url: `/publish-jobs/${JOB_ID}/media`,
    });

    expect(response.statusCode).toBe(200);
    findPublishingApiContract('job.media.create').responseSchema.parse(response.json());
    expect(api.requestMedia).toHaveBeenCalledWith(
      {},
      { tenantId: TENANT_ID, userId: USER_ID },
      JOB_ID,
      3,
      REQUEST_ID,
    );
  });

  it('resolves a Baijiahao unknown state through an idempotent versioned route', async () => {
    const response = await application.inject({
      headers: { 'idempotency-key': 'resolve-unknown-0001', 'if-match': '"3"' },
      method: 'POST',
      payload: { resolution: 'not_published' },
      url: `/publish-jobs/${JOB_ID}/resolve-unknown`,
    });

    expect(response.statusCode).toBe(200);
    findPublishingApiContract('job.unknown.resolve').responseSchema.parse(response.json());
    expect(jobs.resolveUnknownInTransaction).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ tenantId: TENANT_ID, userId: USER_ID }),
      JOB_ID,
      3,
      { resolution: 'not_published' },
    );
    expect(idempotency.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        fingerprint: expect.objectContaining({
          path: `/publish-jobs/${JOB_ID}/resolve-unknown`,
        }),
        idempotencyKey: 'resolve-unknown-0001',
      }),
      expect.any(Function),
    );
  });

  it('requeues only Baijiahao reconciliation through an idempotent versioned route', async () => {
    const response = await application.inject({
      headers: { 'idempotency-key': 'reconcile-publish-0001', 'if-match': '"3"' },
      method: 'POST',
      payload: {},
      url: `/publish-jobs/${JOB_ID}/reconcile`,
    });

    expect(response.statusCode).toBe(200);
    findPublishingApiContract('job.reconcile').responseSchema.parse(response.json());
    expect(jobs.requestBaijiahaoReconciliationInTransaction).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ tenantId: TENANT_ID, userId: USER_ID }),
      JOB_ID,
      3,
    );
    expect(idempotency.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        fingerprint: expect.objectContaining({ path: `/publish-jobs/${JOB_ID}/reconcile` }),
        idempotencyKey: 'reconcile-publish-0001',
      }),
      expect.any(Function),
    );
  });

  it('restarts an exhausted daily batch through an idempotent account-scoped route', async () => {
    const response = await application.inject({
      headers: { 'idempotency-key': 'daily-batch-restart-0001' },
      method: 'POST',
      payload: { expected_batch_version: 4, project_id: PROJECT_ID },
      url: `/platform-accounts/${ACCOUNT_ID}/official-site-automation/daily-batch/restart`,
    });

    expect(response.statusCode).toBe(201);
    findPublishingApiContract(
      'account.official_site_automation.daily_batch.restart',
    ).responseSchema.parse(response.json());
    expect(automation.restartDailyBatchInTransaction).toHaveBeenCalledWith(
      {},
      { tenantId: TENANT_ID, userId: USER_ID },
      ACCOUNT_ID,
      { expected_batch_version: 4, project_id: PROJECT_ID },
      expect.objectContaining({ requestId: REQUEST_ID }),
    );
    expect(idempotency.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        fingerprint: expect.objectContaining({
          path: `/platform-accounts/${ACCOUNT_ID}/official-site-automation/daily-batch/restart`,
        }),
        idempotencyKey: 'daily-batch-restart-0001',
      }),
      expect.any(Function),
    );
  });

  it('restarts an exhausted browser-platform batch without replacing history', async () => {
    const response = await application.inject({
      headers: { 'idempotency-key': 'browser-daily-batch-restart-0001' },
      method: 'POST',
      payload: { expected_batch_version: 2, project_id: PROJECT_ID },
      url: `/platform-accounts/${ACCOUNT_ID}/content-automation/daily-batch/restart`,
    });

    expect(response.statusCode).toBe(201);
    findPublishingApiContract(
      'account.browser_platform_automation.daily_batch.restart',
    ).responseSchema.parse(response.json());
    expect(browserPlatformAutomation.restartDailyBatchInTransaction).toHaveBeenCalledWith(
      {},
      { tenantId: TENANT_ID, userId: USER_ID },
      ACCOUNT_ID,
      { expected_batch_version: 2, project_id: PROJECT_ID },
      expect.objectContaining({ requestId: REQUEST_ID }),
    );
  });

  it('cancels a running daily batch through an idempotent account-scoped route', async () => {
    const response = await application.inject({
      headers: { 'idempotency-key': 'daily-batch-cancel-0001' },
      method: 'POST',
      payload: { expected_batch_version: 1, project_id: PROJECT_ID },
      url: `/platform-accounts/${ACCOUNT_ID}/official-site-automation/daily-batch/cancel`,
    });

    expect(response.statusCode).toBe(200);
    findPublishingApiContract(
      'account.official_site_automation.daily_batch.cancel',
    ).responseSchema.parse(response.json());
    expect(automation.cancelDailyBatchInTransaction).toHaveBeenCalledWith(
      {},
      { tenantId: TENANT_ID, userId: USER_ID },
      ACCOUNT_ID,
      { expected_batch_version: 1, project_id: PROJECT_ID },
      expect.objectContaining({ requestId: REQUEST_ID }),
    );
    expect(idempotency.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        fingerprint: expect.objectContaining({
          path: `/platform-accounts/${ACCOUNT_ID}/official-site-automation/daily-batch/cancel`,
        }),
        idempotencyKey: 'daily-batch-cancel-0001',
      }),
      expect.any(Function),
    );
  });

  it('returns the safe browser gateway reason for a failed Baijiahao login', async () => {
    baijiahaoAutomation.startLogin.mockRejectedValueOnce(
      new PlatformAccountError(
        'PLATFORM_ACCOUNT_STATE_INVALID',
        'Baijiahao browser gateway rejected the operation',
        { reason: 'PAGE_SIGNATURE_CHANGED', upstream_status: 423 },
      ),
    );

    const response = await application.inject({
      headers: { 'if-match': '"4"' },
      method: 'POST',
      url: `/platform-accounts/${ACCOUNT_ID}/baijiahao-browser-session/login`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'STATE_TRANSITION_INVALID',
        details: { reason: 'PAGE_SIGNATURE_CHANGED', upstream_status: 423 },
        message: '状态转换不允许',
        request_id: REQUEST_ID,
      },
    });
  });

  it('returns 503 when the Baijiahao browser worker is temporarily unavailable', async () => {
    baijiahaoAutomation.startLogin.mockRejectedValueOnce(
      new PlatformAccountError(
        'PLATFORM_ACCOUNT_STATE_INVALID',
        'Baijiahao browser gateway rejected the operation',
        { reason: 'BROWSER_GATEWAY_UNAVAILABLE', upstream_status: 503 },
      ),
    );

    const response = await application.inject({
      headers: { 'if-match': '"4"' },
      method: 'POST',
      url: `/platform-accounts/${ACCOUNT_ID}/baijiahao-browser-session/login`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: 'BROWSER_GATEWAY_UNAVAILABLE',
        details: { reason: 'BROWSER_GATEWAY_UNAVAILABLE', upstream_status: 503 },
        message: '托管浏览器服务暂时不可用',
        request_id: REQUEST_ID,
      },
    });
  });
});

class MockPublishingGuard implements CanActivate {
  public canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    setPolicyContext(request, {
      activeTenantId: TENANT_ID,
      permissions: new Set(['publishing.manage']),
      platformRoles: [],
      roles: ['publisher'],
      sessionId: 'mock-session',
      tenantRole: 'publisher',
      userId: USER_ID,
    });
    return true;
  }
}
