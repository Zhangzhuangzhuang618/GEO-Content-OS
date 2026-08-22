import { afterEach, describe, expect, it, vi } from 'vitest';

import { startBaijiahaoBrowserLogin, updatePlatformAccount } from './platform-account-api';
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
