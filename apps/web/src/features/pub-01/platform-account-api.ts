import { createRequestUuid } from '../../lib/request-uuid';

import {
  BaijiahaoAutomationPolicyPageSchema,
  BaijiahaoAutomationPolicyResponseSchema,
  BaijiahaoBrowserLoginResponseSchema,
  BaijiahaoBrowserSessionResponseSchema,
  BrowserPlatformAutomationPolicyPageSchema,
  BrowserPlatformAutomationPolicyResponseSchema,
  CapabilityResponseSchema,
  PlatformAccountPageSchema,
  PlatformAccountResponseSchema,
  ProjectKeywordPlatformScopeSyncResponseSchema,
  OfficialSiteAutomationPolicyPageSchema,
  OfficialSiteAutomationPolicyResponseSchema,
  type PlatformAccount,
  type PlatformAccountFilters,
  type PlatformAccountEdit,
  type PlatformAccountForm,
  type PlatformCode,
  type LiejuBrowserLoginInput,
  type SohuBrowserLoginInput,
} from './platform-account.schema';
import type { OfficialSiteAutomationPolicy } from './platform-account.schema';
import type {
  BaijiahaoAutomationPolicy,
  BaijiahaoBrowserLogin,
  BaijiahaoBrowserSession,
  BrowserPlatformAutomationPolicy,
} from './platform-account.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function syncProjectKeywordPlatformScope(
  projectId: string,
  platformCode: PlatformCode,
  csrf: string,
) {
  const response = await fetch(`${API_ORIGIN}/api/v1/keyword-sets/sync-platform-scope`, {
    body: JSON.stringify({ platform_codes: [platformCode], project_id: projectId }),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `keyword-platform-sync-${createRequestUuid()}`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  if (!response.ok) throw await parseRequestError(response);
  const parsed = ProjectKeywordPlatformScopeSyncResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformAccountRequestError(502);
  return parsed.data.data;
}

export async function listPlatformAccounts(filters: PlatformAccountFilters, signal?: AbortSignal) {
  const query = new URLSearchParams();
  if (filters.platformCode) query.set('platform_code', filters.platformCode);
  if (filters.status) query.set('status', filters.status);
  if (filters.workspaceId) query.set('workspace_id', filters.workspaceId);
  const suffix = query.size ? `?${query}` : '';
  const response = await fetch(`${API_ORIGIN}/api/v1/platform-accounts${suffix}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new PlatformAccountRequestError(response.status);
  const parsed = PlatformAccountPageSchema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformAccountRequestError(502);
  return parsed.data.data;
}

export async function createPlatformAccount(
  form: PlatformAccountForm,
  csrf: string,
): Promise<PlatformAccount> {
  const response = await fetch(`${API_ORIGIN}/api/v1/platform-accounts`, {
    body: JSON.stringify({
      ...(form.publish_mode === 'api' && form.platform_code === 'lieju'
        ? {
            credential: {
              api_key: form.api_key.trim(),
              delivery_method: 'official_api',
              posting_profile: {
                contact_name: form.contact_name.trim(),
                mobile_phone: form.mobile_phone.trim(),
                qq: form.qq.trim(),
                wechat: form.wechat.trim(),
                zone_id: form.zone_id,
              },
            },
          }
        : form.publish_mode === 'api' && !['baijiahao', 'sohu'].includes(form.platform_code)
          ? {
              credential: {
                base_url: form.base_url.trim(),
                bearer_token: form.bearer_token,
              },
            }
          : {}),
      display_name: form.display_name.trim(),
      platform_code: form.platform_code,
      ...(form.publishing_url.trim() ? { publishing_url: form.publishing_url.trim() } : {}),
      publish_mode: form.publish_mode,
      timezone: form.timezone.trim(),
      workspace_id: form.workspace_id,
    }),
    credentials: 'include',
    headers: jsonWriteHeaders(csrf, undefined, 'platform-account-create'),
    method: 'POST',
  });
  return parseAccount(response);
}

export async function refreshPlatformAccount(account: PlatformAccount, csrf: string) {
  const response = await fetch(`${API_ORIGIN}/api/v1/platform-accounts/${account.id}/refresh`, {
    body: '{}',
    credentials: 'include',
    headers: jsonWriteHeaders(csrf, account.version),
    method: 'POST',
  });
  return parseAccount(response);
}

export async function updatePlatformAccount(
  account: PlatformAccount,
  form: PlatformAccountEdit,
  csrf: string,
) {
  const baseUrl = form.base_url.trim();
  const token = form.bearer_token.trim();
  const liejuApiKey = form.api_key.trim();
  const response = await fetch(`${API_ORIGIN}/api/v1/platform-accounts/${account.id}`, {
    body: JSON.stringify({
      ...(account.platform_code === 'lieju' && liejuApiKey
        ? { credential: { api_key: liejuApiKey, delivery_method: 'official_api' } }
        : baseUrl && token
          ? { credential: { base_url: baseUrl, bearer_token: form.bearer_token } }
          : {}),
      display_name: form.display_name.trim(),
      publishing_url: form.publishing_url.trim() || null,
      publish_mode: form.publish_mode,
      timezone: form.timezone.trim(),
    }),
    credentials: 'include',
    headers: jsonWriteHeaders(csrf, account.version),
    method: 'PATCH',
  });
  return parseAccount(response);
}

export async function testPlatformAccount(account: PlatformAccount, csrf: string) {
  const response = await fetch(`${API_ORIGIN}/api/v1/platform-accounts/${account.id}/test`, {
    credentials: 'include',
    headers: writeHeaders(csrf, account.version),
    method: 'POST',
  });
  if (!response.ok) throw new PlatformAccountRequestError(response.status);
  const parsed = CapabilityResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformAccountRequestError(502);
  return parsed.data.data;
}

export async function disablePlatformAccount(
  account: PlatformAccount,
  reason: string,
  csrf: string,
) {
  const response = await fetch(`${API_ORIGIN}/api/v1/platform-accounts/${account.id}/disable`, {
    body: JSON.stringify({ reason }),
    credentials: 'include',
    headers: jsonWriteHeaders(csrf, account.version),
    method: 'POST',
  });
  return parseAccount(response);
}

export async function restorePlatformAccount(account: PlatformAccount, csrf: string) {
  const response = await fetch(`${API_ORIGIN}/api/v1/platform-accounts/${account.id}/restore`, {
    credentials: 'include',
    headers: writeHeaders(csrf, account.version),
    method: 'POST',
  });
  return parseAccount(response);
}

export async function removePlatformAccount(account: PlatformAccount, csrf: string) {
  const response = await fetch(`${API_ORIGIN}/api/v1/platform-accounts/${account.id}`, {
    credentials: 'include',
    headers: writeHeaders(csrf, account.version),
    method: 'DELETE',
  });
  return parseAccount(response);
}

export async function listOfficialSiteAutomationPolicies(
  accountId: string,
  signal?: AbortSignal,
): Promise<readonly OfficialSiteAutomationPolicy[]> {
  const response = await fetch(
    `${API_ORIGIN}/api/v1/platform-accounts/${accountId}/official-site-automation`,
    {
      credentials: 'include',
      method: 'GET',
      ...(signal ? { signal } : {}),
    },
  );
  if (!response.ok) throw new PlatformAccountRequestError(response.status);
  const parsed = OfficialSiteAutomationPolicyPageSchema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformAccountRequestError(502);
  return parsed.data.data;
}

export async function saveOfficialSiteAutomationPolicy(
  accountId: string,
  input: {
    readonly dailyEnabled: boolean;
    readonly enabled: boolean;
    readonly expectedVersion?: number;
    readonly projectId: string;
  },
  csrf: string,
): Promise<OfficialSiteAutomationPolicy> {
  const response = await fetch(
    `${API_ORIGIN}/api/v1/platform-accounts/${accountId}/official-site-automation`,
    {
      body: JSON.stringify({
        daily_enabled: input.dailyEnabled,
        enabled: input.enabled,
        ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }),
        project_id: input.projectId,
      }),
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      method: 'PUT',
    },
  );
  if (!response.ok) throw new PlatformAccountRequestError(response.status);
  const parsed = OfficialSiteAutomationPolicyResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformAccountRequestError(502);
  return parsed.data.data;
}

export async function restartOfficialSiteDailyBatch(
  accountId: string,
  input: {
    readonly expectedBatchVersion: number;
    readonly projectId: string;
  },
  csrf: string,
): Promise<OfficialSiteAutomationPolicy> {
  const response = await fetch(
    `${API_ORIGIN}/api/v1/platform-accounts/${accountId}/official-site-automation/daily-batch/restart`,
    {
      body: JSON.stringify({
        expected_batch_version: input.expectedBatchVersion,
        project_id: input.projectId,
      }),
      credentials: 'include',
      headers: jsonWriteHeaders(csrf, undefined, 'official-site-daily-batch-restart'),
      method: 'POST',
    },
  );
  if (!response.ok) throw new PlatformAccountRequestError(response.status);
  const parsed = OfficialSiteAutomationPolicyResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformAccountRequestError(502);
  return parsed.data.data;
}

export async function cancelOfficialSiteDailyBatch(
  accountId: string,
  input: {
    readonly expectedBatchVersion: number;
    readonly projectId: string;
  },
  csrf: string,
): Promise<OfficialSiteAutomationPolicy> {
  const response = await fetch(
    `${API_ORIGIN}/api/v1/platform-accounts/${accountId}/official-site-automation/daily-batch/cancel`,
    {
      body: JSON.stringify({
        expected_batch_version: input.expectedBatchVersion,
        project_id: input.projectId,
      }),
      credentials: 'include',
      headers: jsonWriteHeaders(csrf, undefined, 'official-site-daily-batch-cancel'),
      method: 'POST',
    },
  );
  if (!response.ok) throw new PlatformAccountRequestError(response.status);
  const parsed = OfficialSiteAutomationPolicyResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformAccountRequestError(502);
  return parsed.data.data;
}

export async function listBaijiahaoAutomationPolicies(
  accountId: string,
  signal?: AbortSignal,
): Promise<readonly BaijiahaoAutomationPolicy[]> {
  const response = await fetch(
    `${API_ORIGIN}/api/v1/platform-accounts/${accountId}/baijiahao-automation`,
    { credentials: 'include', method: 'GET', ...(signal ? { signal } : {}) },
  );
  if (!response.ok) throw new PlatformAccountRequestError(response.status);
  const parsed = BaijiahaoAutomationPolicyPageSchema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformAccountRequestError(502);
  return parsed.data.data;
}

export async function listBrowserPlatformAutomationPolicies(
  accountId: string,
  signal?: AbortSignal,
): Promise<readonly BrowserPlatformAutomationPolicy[]> {
  const response = await fetch(
    `${API_ORIGIN}/api/v1/platform-accounts/${accountId}/content-automation`,
    { credentials: 'include', method: 'GET', ...(signal ? { signal } : {}) },
  );
  if (!response.ok) throw new PlatformAccountRequestError(response.status);
  const parsed = BrowserPlatformAutomationPolicyPageSchema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformAccountRequestError(502);
  return parsed.data.data;
}

export async function saveBrowserPlatformAutomationPolicy(
  accountId: string,
  input: {
    readonly dailyCandidateLimit: number;
    readonly dailyEnabled: boolean;
    readonly dailyGenerationTime: string;
    readonly dailyScheduleTimes: readonly string[];
    readonly dailyTargetCount: number;
    readonly enabled: boolean;
    readonly expectedVersion?: number;
    readonly projectId: string;
  },
  csrf: string,
): Promise<BrowserPlatformAutomationPolicy> {
  const response = await fetch(
    `${API_ORIGIN}/api/v1/platform-accounts/${accountId}/content-automation`,
    {
      body: JSON.stringify({
        daily_candidate_limit: input.dailyCandidateLimit,
        daily_enabled: input.dailyEnabled,
        daily_generation_time: input.dailyGenerationTime,
        daily_schedule_times: input.dailyScheduleTimes,
        daily_target_count: input.dailyTargetCount,
        enabled: input.enabled,
        ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }),
        project_id: input.projectId,
      }),
      credentials: 'include',
      headers: jsonWriteHeaders(csrf),
      method: 'PUT',
    },
  );
  if (!response.ok) throw new PlatformAccountRequestError(response.status);
  const parsed = BrowserPlatformAutomationPolicyResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformAccountRequestError(502);
  return parsed.data.data;
}

export async function retryBrowserPlatformDailyBatch(
  accountId: string,
  input: {
    readonly expectedBatchVersion: number;
    readonly projectId: string;
  },
  csrf: string,
): Promise<BrowserPlatformAutomationPolicy> {
  const response = await fetch(
    `${API_ORIGIN}/api/v1/platform-accounts/${accountId}/content-automation/daily-batch/retry`,
    {
      body: JSON.stringify({
        expected_batch_version: input.expectedBatchVersion,
        project_id: input.projectId,
      }),
      credentials: 'include',
      headers: jsonWriteHeaders(csrf, undefined, 'browser-platform-daily-batch-retry'),
      method: 'POST',
    },
  );
  if (!response.ok) throw new PlatformAccountRequestError(response.status);
  const parsed = BrowserPlatformAutomationPolicyResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformAccountRequestError(502);
  return parsed.data.data;
}

export async function saveBaijiahaoAutomationPolicy(
  accountId: string,
  input: {
    readonly dailyCandidateLimit: number;
    readonly dailyEnabled: boolean;
    readonly dailyGenerationTime: string;
    readonly dailyScheduleTimes: readonly string[];
    readonly dailyTargetCount: number;
    readonly enabled: boolean;
    readonly expectedVersion?: number;
    readonly independentFallbackEnabled: boolean;
    readonly projectId: string;
    readonly sourceMode: 'official_site_derived' | 'independent';
  },
  csrf: string,
): Promise<BaijiahaoAutomationPolicy> {
  const response = await fetch(
    `${API_ORIGIN}/api/v1/platform-accounts/${accountId}/baijiahao-automation`,
    {
      body: JSON.stringify({
        daily_candidate_limit: input.dailyCandidateLimit,
        daily_enabled: input.dailyEnabled,
        daily_generation_time: input.dailyGenerationTime,
        daily_schedule_times: input.dailyScheduleTimes,
        daily_target_count: input.dailyTargetCount,
        enabled: input.enabled,
        ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }),
        independent_fallback_enabled: input.independentFallbackEnabled,
        project_id: input.projectId,
        source_mode: input.sourceMode,
      }),
      credentials: 'include',
      headers: jsonWriteHeaders(csrf),
      method: 'PUT',
    },
  );
  if (!response.ok) throw new PlatformAccountRequestError(response.status);
  const parsed = BaijiahaoAutomationPolicyResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformAccountRequestError(502);
  return parsed.data.data;
}

export async function getBaijiahaoBrowserSession(
  accountId: string,
  signal?: AbortSignal,
): Promise<BaijiahaoBrowserSession> {
  const response = await fetch(
    `${API_ORIGIN}/api/v1/platform-accounts/${accountId}/baijiahao-browser-session`,
    { credentials: 'include', method: 'GET', ...(signal ? { signal } : {}) },
  );
  if (!response.ok) throw new PlatformAccountRequestError(response.status);
  const parsed = BaijiahaoBrowserSessionResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformAccountRequestError(502);
  return parsed.data.data;
}

export async function startBaijiahaoBrowserLogin(
  account: PlatformAccount,
  csrf: string,
  reauthenticate = false,
): Promise<BaijiahaoBrowserLogin> {
  const action = reauthenticate ? 'reauth' : 'login';
  const response = await fetch(
    `${API_ORIGIN}/api/v1/platform-accounts/${account.id}/baijiahao-browser-session/${action}`,
    {
      credentials: 'include',
      headers: writeHeaders(csrf, account.version),
      method: 'POST',
    },
  );
  if (!response.ok) throw await parseRequestError(response);
  const parsed = BaijiahaoBrowserLoginResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformAccountRequestError(502);
  return parsed.data.data;
}

export async function getSohuBrowserSession(
  accountId: string,
  signal?: AbortSignal,
): Promise<BaijiahaoBrowserSession> {
  const response = await fetch(
    `${API_ORIGIN}/api/v1/platform-accounts/${accountId}/sohu-browser-session`,
    { credentials: 'include', method: 'GET', ...(signal ? { signal } : {}) },
  );
  if (!response.ok) throw new PlatformAccountRequestError(response.status);
  const parsed = BaijiahaoBrowserSessionResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformAccountRequestError(502);
  return parsed.data.data;
}

export async function startSohuBrowserLogin(
  account: PlatformAccount,
  csrf: string,
  input: SohuBrowserLoginInput = { method: 'wechat' },
  reauthenticate = false,
): Promise<BaijiahaoBrowserLogin> {
  const action = reauthenticate ? 'reauth' : 'login';
  const response = await fetch(
    `${API_ORIGIN}/api/v1/platform-accounts/${account.id}/sohu-browser-session/${action}`,
    {
      credentials: 'include',
      body: JSON.stringify(input),
      headers: { ...writeHeaders(csrf, account.version), 'content-type': 'application/json' },
      method: 'POST',
    },
  );
  if (!response.ok) throw await parseRequestError(response);
  const parsed = BaijiahaoBrowserLoginResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformAccountRequestError(502);
  return parsed.data.data;
}

export async function getLiejuBrowserSession(
  accountId: string,
  signal?: AbortSignal,
): Promise<BaijiahaoBrowserSession> {
  const response = await fetch(
    `${API_ORIGIN}/api/v1/platform-accounts/${accountId}/lieju-browser-session`,
    { credentials: 'include', method: 'GET', ...(signal ? { signal } : {}) },
  );
  if (!response.ok) throw new PlatformAccountRequestError(response.status);
  const parsed = BaijiahaoBrowserSessionResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformAccountRequestError(502);
  return parsed.data.data;
}

export async function startLiejuBrowserLogin(
  account: PlatformAccount,
  csrf: string,
  input: LiejuBrowserLoginInput = { method: 'qq' },
  reauthenticate = false,
): Promise<BaijiahaoBrowserLogin> {
  const action = reauthenticate ? 'reauth' : 'login';
  const response = await fetch(
    `${API_ORIGIN}/api/v1/platform-accounts/${account.id}/lieju-browser-session/${action}`,
    {
      credentials: 'include',
      body: JSON.stringify(input),
      headers: { ...writeHeaders(csrf, account.version), 'content-type': 'application/json' },
      method: 'POST',
    },
  );
  if (!response.ok) throw await parseRequestError(response);
  const parsed = BaijiahaoBrowserLoginResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformAccountRequestError(502);
  return parsed.data.data;
}

export class PlatformAccountRequestError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super('Platform account request failed');
    this.name = 'PlatformAccountRequestError';
  }
}

async function parseRequestError(response: Response): Promise<PlatformAccountRequestError> {
  try {
    const value = (await response.json()) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return new PlatformAccountRequestError(response.status);
    }
    const error = (value as Readonly<Record<string, unknown>>)['error'];
    if (!error || typeof error !== 'object' || Array.isArray(error)) {
      return new PlatformAccountRequestError(response.status);
    }
    const candidate = error as Readonly<Record<string, unknown>>;
    const details = candidate['details'];
    return new PlatformAccountRequestError(
      response.status,
      typeof candidate['code'] === 'string' ? candidate['code'] : undefined,
      details && typeof details === 'object' && !Array.isArray(details)
        ? (details as Readonly<Record<string, unknown>>)
        : undefined,
    );
  } catch {
    return new PlatformAccountRequestError(response.status);
  }
}

async function parseAccount(response: Response) {
  if (!response.ok) throw new PlatformAccountRequestError(response.status);
  const parsed = PlatformAccountResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PlatformAccountRequestError(502);
  return parsed.data.data;
}

function writeHeaders(csrf: string, version?: number, operation?: string) {
  return {
    ...(operation ? { 'idempotency-key': `${operation}-${createRequestUuid()}` } : {}),
    ...(version === undefined ? {} : { 'if-match': `"${version}"` }),
    'x-csrf-token': csrf,
  };
}

function jsonWriteHeaders(csrf: string, version?: number, operation?: string) {
  return {
    'content-type': 'application/json',
    ...writeHeaders(csrf, version, operation),
  };
}
