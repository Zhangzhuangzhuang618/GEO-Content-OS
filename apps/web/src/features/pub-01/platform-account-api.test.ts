import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  saveBrowserPlatformAutomationPolicy,
  startBaijiahaoBrowserLogin,
  startDouyinBrowserLogin,
  updatePlatformAccount,
} from './platform-account-api';
import type { PlatformAccountRequestError } from './platform-account-api';
import { PlatformAccountEditSchema } from './platform-account.schema';
import type { PlatformAccount, PlatformAccountEdit } from './platform-account.schema';

const ACCOUNT = {
  id: '00000000-0000-4000-8000-000000000145',
  version: 4,
} as PlatformAccount;
const LIEJU_ACCOUNT = {
  capabilities: { delivery_method: 'official_api', publish: true },
  created_at: '2026-08-19T00:00:00.000Z',
  display_name: '列举网生产账号',
  id: '00000000-0000-4000-8000-000000000147',
  platform_code: 'lieju',
  provider_account_id: null,
  publishing_url: null,
  publish_mode: 'api',
  scopes: [],
  status: 'active',
  tenant_id: '00000000-0000-4000-8000-000000000148',
  timezone: 'Asia/Shanghai',
  token_expires_at: null,
  updated_at: '2026-08-19T00:00:00.000Z',
  version: 4,
  workspace_id: '00000000-0000-4000-8000-000000000149',
} satisfies PlatformAccount;

describe('Douyin automation policy API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the complete account strategy to the browser-platform policy endpoint', async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(null, { status: 500 });
      }),
    );

    await expect(
      saveBrowserPlatformAutomationPolicy(
        ACCOUNT.id,
        {
          accountPositioning: '面向广州家庭客户提供搬家决策信息',
          contentVoice: 'customer_perspective',
          dailyCandidateLimit: 9,
          dailyEnabled: true,
          dailyGenerationTime: '00:30:00',
          dailyScheduleTimes: ['08:00:00', '15:30:00', '21:30:00'],
          dailyTargetCount: 3,
          enabled: true,
          projectId: '00000000-0000-4000-8000-000000000150',
          serviceScopes: ['居民搬家', '跨城搬家'],
          targetRegions: ['广州', '佛山'],
          topicPool: ['高层小区家庭搬迁', '收费项目核对'],
        },
        'csrf-token',
      ),
    ).rejects.toMatchObject({ status: 500 });
    expect(requestBody).toMatchObject({
      account_positioning: '面向广州家庭客户提供搬家决策信息',
      content_voice: 'customer_perspective',
      service_scopes: ['居民搬家', '跨城搬家'],
      target_regions: ['广州', '佛山'],
      topic_pool: ['高层小区家庭搬迁', '收费项目核对'],
    });
  });
});

describe('Baijiahao browser login API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retains the public error code and safe gateway reason for the UI', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'STATE_TRANSITION_INVALID',
                details: { reason: 'PAGE_SIGNATURE_CHANGED', upstream_status: 423 },
                message: '状态转换不允许',
                request_id: '00000000-0000-4000-8000-000000000146',
              },
            }),
            { status: 409 },
          ),
      ),
    );

    await expect(startBaijiahaoBrowserLogin(ACCOUNT, 'csrf-token')).rejects.toEqual(
      expect.objectContaining<Partial<PlatformAccountRequestError>>({
        code: 'STATE_TRANSITION_INVALID',
        details: { reason: 'PAGE_SIGNATURE_CHANGED', upstream_status: 423 },
        status: 409,
      }),
    );
  });

  it('retains a temporary browser gateway outage as HTTP 503', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'BROWSER_GATEWAY_UNAVAILABLE',
                details: { reason: 'BROWSER_GATEWAY_UNAVAILABLE', upstream_status: 503 },
                message: '托管浏览器服务暂时不可用',
                request_id: '00000000-0000-4000-8000-000000000146',
              },
            }),
            { status: 503 },
          ),
      ),
    );

    await expect(startBaijiahaoBrowserLogin(ACCOUNT, 'csrf-token')).rejects.toEqual(
      expect.objectContaining<Partial<PlatformAccountRequestError>>({
        code: 'BROWSER_GATEWAY_UNAVAILABLE',
        details: { reason: 'BROWSER_GATEWAY_UNAVAILABLE', upstream_status: 503 },
        status: 503,
      }),
    );
  });
});

describe('Douyin browser login API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refreshes a stale account version and retries the login once', async () => {
    const account = {
      ...LIEJU_ACCOUNT,
      id: '00000000-0000-4000-8000-000000000158',
      platform_code: 'douyin' as const,
      version: 2,
    } satisfies PlatformAccount;
    const current = { ...account, status: 'reauth' as const, version: 3 };
    const login = {
      account_id: account.id,
      authenticated_at: null,
      last_verified_at: null,
      qr_expires_at: '2026-08-27T01:03:00.000Z',
      qr_image_data_url: 'data:image/png;base64,cXItYnl0ZXM=',
      status: 'qr_ready',
      version: 24,
    } as const;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 'PLATFORM_ACCOUNT_VERSION_CONFLICT',
              message: '账号版本已变化',
              request_id: '00000000-0000-4000-8000-000000000159',
            },
          }),
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [current],
            meta: { request_id: '00000000-0000-4000-8000-000000000160' },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: login,
            meta: { request_id: '00000000-0000-4000-8000-000000000161' },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(startDouyinBrowserLogin(account, 'csrf-token', true)).resolves.toEqual(login);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ 'if-match': '"2"' });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      `platform_code=douyin&workspace_id=${account.workspace_id}`,
    );
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({ 'if-match': '"3"' });
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({ method: 'qr' }));
  });

  it('uses the isolated Douyin session route and keeps safe diagnostics', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'STATE_TRANSITION_INVALID',
              details: { reason: 'CAPTCHA_REQUIRED', upstream_status: 423 },
              message: '需要人工验证',
              request_id: '00000000-0000-4000-8000-000000000158',
            },
          }),
          { status: 409 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const account = { ...ACCOUNT, platform_code: 'douyin' } as PlatformAccount;

    await expect(startDouyinBrowserLogin(account, 'csrf-token')).rejects.toEqual(
      expect.objectContaining<Partial<PlatformAccountRequestError>>({
        code: 'STATE_TRANSITION_INVALID',
        details: { reason: 'CAPTCHA_REQUIRED', upstream_status: 423 },
        status: 409,
      }),
    );
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      `/platform-accounts/${ACCOUNT.id}/douyin-browser-session/login`,
    );
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ method: 'qr' }));
  });

  it('sends a secondary verification action only to the isolated Douyin route', async () => {
    const account = {
      ...LIEJU_ACCOUNT,
      id: '00000000-0000-4000-8000-000000000158',
      platform_code: 'douyin' as const,
      version: 2,
    } satisfies PlatformAccount;
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              account_id: account.id,
              authenticated_at: null,
              last_verified_at: null,
              qr_expires_at: null,
              status: 'attention_required',
              verification: {
                available_methods: ['sms_code'],
                captured_at: '2026-08-28T07:36:24.000Z',
                challenge_type: 'sms_code',
                has_code_input: true,
                page_origin: 'https://creator.douyin.com',
                page_path: '/passport/safe/verify',
                page_signature: 'a'.repeat(64),
              },
              version: 2,
            },
            meta: { request_id: '00000000-0000-4000-8000-000000000161' },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      startDouyinBrowserLogin(account, 'csrf-token', false, {
        method: 'verification_sms_send',
      }),
    ).resolves.toMatchObject({
      status: 'attention_required',
      verification: { challenge_type: 'sms_code' },
    });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ method: 'verification_sms_send' }),
    );
  });
});

describe('Lieju account updates', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends replacements and explicit clears without requiring the API key again', async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            data: { ...LIEJU_ACCOUNT, version: 5 },
            meta: { request_id: '00000000-0000-4000-8000-000000000150' },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        );
      }),
    );
    const form = {
      address: '',
      api_key: '',
      base_url: '',
      bearer_token: '',
      clear_qq: true,
      clear_wechat: true,
      contact_name: '',
      display_name: LIEJU_ACCOUNT.display_name,
      mobile_phone: '02085627757',
      publishing_url: '',
      publish_mode: 'api',
      qq: '',
      timezone: 'Asia/Shanghai',
      wechat: '',
      zone_id: '79',
    } satisfies PlatformAccountEdit;

    await expect(updatePlatformAccount(LIEJU_ACCOUNT, form, 'csrf-token')).resolves.toMatchObject({
      version: 5,
    });
    expect(requestBody).toMatchObject({
      credential: {
        delivery_method: 'official_api',
        posting_profile: {
          mobile_phone: '02085627757',
          qq: '',
          wechat: '',
          zone_id: '79',
        },
      },
    });
    expect(requestBody?.['credential']).not.toHaveProperty('api_key');
  });

  it('rejects invalid contact replacements and conflicting clear choices in the browser', () => {
    const result = PlatformAccountEditSchema.safeParse({
      address: '',
      api_key: '',
      base_url: '',
      bearer_token: '',
      clear_qq: false,
      clear_wechat: true,
      contact_name: '',
      display_name: LIEJU_ACCOUNT.display_name,
      mobile_phone: '',
      publishing_url: '',
      publish_mode: 'api',
      qq: '',
      timezone: 'Asia/Shanghai',
      wechat: '123456',
      zone_id: '',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path[0])).toContain('wechat');
    }
  });
});
