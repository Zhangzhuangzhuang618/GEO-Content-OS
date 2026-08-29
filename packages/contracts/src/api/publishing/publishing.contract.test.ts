import { describe, expect, it } from 'vitest';

import {
  BaijiahaoDailyBatchRestartRequestSchema,
  BrowserPlatformAutomationPolicyRequestSchema,
  BrowserPlatformDailyBatchRestartRequestSchema,
  BrowserPlatformDailyBatchRetryRequestSchema,
  BrowserPlatformDailyBatchSummarySchema,
  CreatePlatformAccountRequestSchema,
  DouyinBrowserLoginRequestSchema,
  DouyinBrowserSessionViewSchema,
  OfficialSiteDailyBatchCancelRequestSchema,
  OfficialSiteDailyBatchRestartRequestSchema,
  PUBLISHING_API_CONTRACTS,
  PUBLISHING_OPENAPI_DOCUMENT,
  PublishJobQuerySchema,
  ResolveUnknownPublishRequestSchema,
  SohuBrowserLoginRequestSchema,
  LiejuBrowserLoginRequestSchema,
} from './index.js';

describe('Publishing API frozen contract', () => {
  it('returns actionable browser-platform daily batch items', () => {
    const parsed = BrowserPlatformDailyBatchSummarySchema.parse({
      attempt_no: 1,
      attempted_count: 1,
      business_date: '2026-08-16',
      in_progress_count: 0,
      last_error_message: '需要人工处理',
      manual_items: [
        {
          automation_run_id: '10000000-0000-4000-8000-000000000001',
          candidate_no: 1,
          content_version_id: '20000000-0000-4000-8000-000000000001',
          last_error: { code: 'QUALITY_GATE_FAILED_AFTER_MAX_REWRITES' },
          package_id: '30000000-0000-4000-8000-000000000001',
          publish_job_id: null,
          quality_report_id: '40000000-0000-4000-8000-000000000001',
          rewrite_count: 3,
          title: '广州搬家准备清单',
          updated_at: '2026-08-16T01:00:00.000Z',
          variant_id: '50000000-0000-4000-8000-000000000001',
        },
      ],
      manual_required_count: 1,
      published_count: 0,
      restart_allowed: false,
      retry_allowed: false,
      retired_count: 0,
      scheduled_count: 0,
      status: 'attention_required',
      target_count: 1,
      version: 1,
    });
    expect(parsed.manual_items[0]?.quality_report_id).toBe('40000000-0000-4000-8000-000000000001');
  });

  it('contains all forty-one publishing endpoints exactly once', () => {
    expect(PUBLISHING_API_CONTRACTS).toHaveLength(41);
    expect(
      new Set(PUBLISHING_API_CONTRACTS.map(({ method, path }) => `${method} ${path}`)).size,
    ).toBe(41);
    expect(
      PUBLISHING_API_CONTRACTS.every(({ permission }) => permission === 'publishing.manage'),
    ).toBe(true);
  });

  it('requires an optimistic batch version when retrying browser-platform prerequisites', () => {
    expect(
      BrowserPlatformDailyBatchRetryRequestSchema.safeParse({
        expected_batch_version: 2,
        project_id: crypto.randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      BrowserPlatformDailyBatchRetryRequestSchema.safeParse({
        project_id: crypto.randomUUID(),
      }).success,
    ).toBe(false);
  });

  it('uses one optimistic restart contract across daily automation platforms', () => {
    const body = { expected_batch_version: 2, project_id: crypto.randomUUID() };
    expect(BaijiahaoDailyBatchRestartRequestSchema.safeParse(body).success).toBe(true);
    expect(BrowserPlatformDailyBatchRestartRequestSchema.safeParse(body).success).toBe(true);
  });

  it('projects the aggregate into OpenAPI 3.1 with frozen guards', () => {
    expect(PUBLISHING_OPENAPI_DOCUMENT.openapi).toBe('3.1.0');
    const operations = Object.values(PUBLISHING_OPENAPI_DOCUMENT.paths).flatMap((path) =>
      Object.values(path),
    );
    expect(operations).toHaveLength(41);
    for (const contract of PUBLISHING_API_CONTRACTS) {
      const operation = PUBLISHING_OPENAPI_DOCUMENT.paths[contract.path]?.[
        contract.method.toLowerCase()
      ] as Record<string, unknown>;
      expect(operation['x-idempotency']).toBe(contract.idempotency);
      expect(operation['x-permission']).toBe(contract.permission);
      expect(operation['x-policy']).toBe(contract.policy);
    }
  });

  it('keeps browser-platform automation within frozen quality gates', () => {
    expect(
      BrowserPlatformAutomationPolicyRequestSchema.safeParse({
        daily_candidate_limit: 10,
        daily_enabled: true,
        daily_generation_time: '00:30:00',
        daily_schedule_times: ['09:30:00', '15:30:00'],
        daily_target_count: 2,
        enabled: true,
        project_id: crypto.randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      BrowserPlatformAutomationPolicyRequestSchema.safeParse({
        daily_candidate_limit: 2,
        daily_enabled: true,
        daily_schedule_times: ['09:30:00'],
        daily_target_count: 1,
        enabled: true,
        geo_total_min: 84,
        project_id: crypto.randomUUID(),
      }).success,
    ).toBe(false);
  });

  it('requires evidence before confirming an unknown publish as published', () => {
    expect(
      ResolveUnknownPublishRequestSchema.safeParse({ resolution: 'not_published' }).success,
    ).toBe(true);
    expect(
      ResolveUnknownPublishRequestSchema.safeParse({ resolution: 'not_published_closed' }).success,
    ).toBe(true);
    expect(
      ResolveUnknownPublishRequestSchema.safeParse({
        external_url: 'https://baijiahao.baidu.com/s?id=123',
        resolution: 'published',
      }).success,
    ).toBe(true);
    expect(ResolveUnknownPublishRequestSchema.safeParse({ resolution: 'published' }).success).toBe(
      false,
    );
    expect(
      ResolveUnknownPublishRequestSchema.safeParse({
        external_url: 'javascript:alert(1)',
        resolution: 'published',
      }).success,
    ).toBe(false);
  });

  it('requires an optimistic batch version when restarting today', () => {
    expect(
      OfficialSiteDailyBatchRestartRequestSchema.safeParse({
        expected_batch_version: 2,
        project_id: crypto.randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      OfficialSiteDailyBatchRestartRequestSchema.safeParse({
        project_id: crypto.randomUUID(),
      }).success,
    ).toBe(false);
  });

  it('requires an optimistic batch version when cancelling today', () => {
    expect(
      OfficialSiteDailyBatchCancelRequestSchema.safeParse({
        expected_batch_version: 2,
        project_id: crypto.randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      OfficialSiteDailyBatchCancelRequestSchema.safeParse({
        project_id: crypto.randomUUID(),
      }).success,
    ).toBe(false);
  });

  it('accepts only platform-supported ephemeral browser login methods', () => {
    expect(
      SohuBrowserLoginRequestSchema.safeParse({
        accepted_terms: true,
        account: 'publisher@example.com',
        method: 'password',
        password: 'temporary',
      }).success,
    ).toBe(true);
    expect(
      SohuBrowserLoginRequestSchema.safeParse({ method: 'sms_prepare', mobile: '13800138000' })
        .success,
    ).toBe(true);
    expect(
      LiejuBrowserLoginRequestSchema.safeParse({
        method: 'password',
        password: 'temporary',
        username: 'publisher',
      }).success,
    ).toBe(true);
    expect(
      LiejuBrowserLoginRequestSchema.safeParse({ method: 'sms_prepare', mobile: '13800138000' })
        .success,
    ).toBe(false);
  });

  it('keeps Douyin secondary verification inputs ephemeral and diagnostics allowlisted', () => {
    expect(
      DouyinBrowserLoginRequestSchema.safeParse({ method: 'verification_sms_send' }).success,
    ).toBe(true);
    expect(
      DouyinBrowserLoginRequestSchema.safeParse({
        method: 'verification_sms_verify',
        sms_code: '654321',
      }).success,
    ).toBe(true);
    expect(
      DouyinBrowserLoginRequestSchema.safeParse({
        method: 'verification_sms_verify',
        password: 'must-not-be-accepted',
        sms_code: '654321',
      }).success,
    ).toBe(false);
    expect(
      DouyinBrowserLoginRequestSchema.safeParse({
        method: 'verification_sms_verify',
        sms_code: 'code-654321',
      }).success,
    ).toBe(false);

    const safeSession = {
      account_id: crypto.randomUUID(),
      authenticated_at: null,
      last_verified_at: null,
      qr_expires_at: null,
      status: 'attention_required',
      verification: {
        available_methods: ['sms_code', 'original_device_scan'],
        captured_at: '2026-08-28T07:36:24.000Z',
        challenge_type: 'identity_choice',
        diagnostic_image_data_url: 'data:image/png;base64,bWFza2Vk',
        has_code_input: false,
        masked_mobile: '138****5678',
        page_origin: 'https://creator.douyin.com',
        page_path: '/passport/safe/verify',
        page_signature: 'a'.repeat(64),
        sms_resend_available: false,
      },
      version: 2,
    };
    expect(DouyinBrowserSessionViewSchema.safeParse(safeSession).success).toBe(true);
    expect(
      DouyinBrowserSessionViewSchema.safeParse({
        ...safeSession,
        verification: { ...safeSession.verification, mobile: '13800138000' },
      }).success,
    ).toBe(false);
    expect(
      DouyinBrowserSessionViewSchema.safeParse({
        ...safeSession,
        verification: { ...safeSession.verification, masked_mobile: '13800138000' },
      }).success,
    ).toBe(false);
  });

  it('keeps tenant context and credentials out of queries and responses', () => {
    expect(PublishJobQuerySchema.safeParse({ tenant_id: crypto.randomUUID() }).success).toBe(false);
    expect(
      CreatePlatformAccountRequestSchema.safeParse({
        display_name: 'Export account',
        platform_code: 'official_site',
        publish_mode: 'export',
        tenant_id: crypto.randomUUID(),
        timezone: 'Asia/Shanghai',
        workspace_id: crypto.randomUUID(),
      }).success,
    ).toBe(false);
    expect(JSON.stringify(PUBLISHING_OPENAPI_DOCUMENT)).not.toContain('credential_ciphertext');
  });

  it('lets the server inject Baijiahao browser gateway credentials', () => {
    expect(
      CreatePlatformAccountRequestSchema.safeParse({
        display_name: '百家号生产账号',
        platform_code: 'baijiahao',
        publish_mode: 'api',
        timezone: 'Asia/Shanghai',
        workspace_id: crypto.randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      CreatePlatformAccountRequestSchema.safeParse({
        display_name: '官网生产账号',
        platform_code: 'official_site',
        publish_mode: 'api',
        timezone: 'Asia/Shanghai',
        workspace_id: crypto.randomUUID(),
      }).success,
    ).toBe(false);
  });

  it('requires a posting profile for Lieju browser publishing accounts', () => {
    const workspaceId = crypto.randomUUID();
    expect(
      CreatePlatformAccountRequestSchema.safeParse({
        display_name: '列举网生产账号',
        platform_code: 'lieju',
        publish_mode: 'api',
        timezone: 'Asia/Shanghai',
        workspace_id: workspaceId,
      }).success,
    ).toBe(false);
    expect(
      CreatePlatformAccountRequestSchema.safeParse({
        credential: {
          posting_profile: {
            address: '广州市天河区',
            category_id: '4',
            contact_name: '测试联系人',
            mobile_phone: '13800000000',
            zone_id: '5',
          },
        },
        display_name: '列举网生产账号',
        platform_code: 'lieju',
        publish_mode: 'api',
        timezone: 'Asia/Shanghai',
        workspace_id: workspaceId,
      }).success,
    ).toBe(true);
  });

  it('orders calendar bounds by instant instead of timezone text', () => {
    expect(
      PublishJobQuerySchema.safeParse({
        from: '2026-07-16T08:00:00+08:00',
        to: '2026-07-16T01:00:00Z',
      }).success,
    ).toBe(true);
  });
});
