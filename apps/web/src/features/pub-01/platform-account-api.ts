import {
  CapabilityResponseSchema,
  PlatformAccountPageSchema,
  PlatformAccountResponseSchema,
  OfficialSiteAutomationPolicyPageSchema,
  OfficialSiteAutomationPolicyResponseSchema,
  type PlatformAccount,
  type PlatformAccountFilters,
  type PlatformAccountEdit,
  type PlatformAccountForm,
} from './platform-account.schema';
import type { OfficialSiteAutomationPolicy } from './platform-account.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

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
      ...(form.publish_mode === 'api'
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
    headers: writeHeaders(csrf, undefined, 'platform-account-create'),
    method: 'POST',
  });
  return parseAccount(response);
}

export async function refreshPlatformAccount(account: PlatformAccount, csrf: string) {
  const response = await fetch(`${API_ORIGIN}/api/v1/platform-accounts/${account.id}/refresh`, {
    body: '{}',
    credentials: 'include',
    headers: writeHeaders(csrf, account.version),
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
  const response = await fetch(`${API_ORIGIN}/api/v1/platform-accounts/${account.id}`, {
    body: JSON.stringify({
      ...(baseUrl && token
        ? { credential: { base_url: baseUrl, bearer_token: form.bearer_token } }
        : {}),
      display_name: form.display_name.trim(),
      publishing_url: form.publishing_url.trim() || null,
      publish_mode: form.publish_mode,
      timezone: form.timezone.trim(),
    }),
    credentials: 'include',
    headers: writeHeaders(csrf, account.version),
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
    headers: writeHeaders(csrf, account.version),
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

export class PlatformAccountRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Platform account request failed');
    this.name = 'PlatformAccountRequestError';
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
    'content-type': 'application/json',
    ...(operation ? { 'idempotency-key': `${operation}-${crypto.randomUUID()}` } : {}),
    ...(version === undefined ? {} : { 'if-match': `"${version}"` }),
    'x-csrf-token': csrf,
  };
}
