import 'reflect-metadata';

import {
  findPublishingApiContract,
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
import { OfficialSiteAutomationPolicyService, PlatformAccountService } from '../accounts/index.js';
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

describe('publishing API mock E2E', () => {
  let application: NestFastifyApplication;
  const listJobs = vi.fn(async () => ({ items: [job], nextCursor: 'next-page' }));
  const api = {
    attempts: vi.fn(async () => [attempt]),
    detail: vi.fn(async () => detail),
    listJobs,
    signedExport: vi.fn(async () => download),
  };
  const jobs = {
    cancel: vi.fn(async () => ({ ...job, status: 'cancelled' as const, version: 4 })),
    createInTransaction: vi.fn(async () => job),
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
        { provide: OfficialSiteAutomationPolicyService, useValue: automation },
        { provide: PlatformAccountService, useValue: {} },
        { provide: PublishJobService, useValue: jobs },
        { provide: PublishingApiService, useValue: api },
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
