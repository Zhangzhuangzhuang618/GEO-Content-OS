import {
  BaijiahaoBrowserLoginViewSchema,
  BaijiahaoBrowserSessionViewSchema,
  type BaijiahaoBrowserLoginView,
  type BaijiahaoBrowserSessionView,
} from '@geo-content-os/contracts';

import { PlatformAccountError } from './platform-account.errors.js';

export class BaijiahaoBrowserGatewayClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly timeoutMs: number;

  public constructor(environment: NodeJS.ProcessEnv = process.env) {
    const configuration = readBaijiahaoBrowserGatewayCredential(environment, false);
    this.baseUrl = configuration.base_url;
    this.token = configuration.bearer_token || null;
    this.timeoutMs = readGatewayTimeout(environment);
  }

  public login(accountId: string): Promise<BaijiahaoBrowserLoginView> {
    return this.write(accountId, 'login');
  }

  public reauthenticate(accountId: string): Promise<BaijiahaoBrowserLoginView> {
    return this.write(accountId, 'reauth');
  }

  public async status(accountId: string): Promise<BaijiahaoBrowserSessionView> {
    const value = await this.request(`/sessions/${encodeURIComponent(accountId)}`, 'GET');
    const parsed = BaijiahaoBrowserSessionViewSchema.safeParse(value);
    if (!parsed.success) throw unavailable();
    return parsed.data;
  }

  private async write(
    accountId: string,
    action: 'login' | 'reauth',
  ): Promise<BaijiahaoBrowserLoginView> {
    const value = await this.request(
      `/sessions/${encodeURIComponent(accountId)}/${action}`,
      'POST',
    );
    const parsed = BaijiahaoBrowserLoginViewSchema.safeParse(value);
    if (!parsed.success) throw unavailable();
    return parsed.data;
  }

  private async request(path: string, method: 'GET' | 'POST'): Promise<unknown> {
    if (!this.token || this.token.length < 32) {
      throw new PlatformAccountError(
        'PLATFORM_ACCOUNT_STATE_INVALID',
        'Baijiahao browser gateway is not configured',
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        headers: { authorization: `Bearer ${this.token}` },
        method,
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 404) {
          throw new PlatformAccountError(
            'PLATFORM_ACCOUNT_NOT_FOUND',
            'Baijiahao browser session was not found',
          );
        }
        throw await upstreamFailure(response);
      }
      return response.json() as Promise<unknown>;
    } catch (error) {
      if (error instanceof PlatformAccountError) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timeout);
    }
  }
}

function readGatewayTimeout(environment: NodeJS.ProcessEnv): number {
  const configured = environment['BAIJIAHAO_BROWSER_GATEWAY_TIMEOUT_MS']?.trim();
  const value = Number(configured || 65_000);
  if (!Number.isInteger(value) || value < 1_000 || value > 120_000) {
    throw new Error('BAIJIAHAO_BROWSER_GATEWAY_TIMEOUT_MS is invalid');
  }
  return value;
}

export function readBaijiahaoBrowserGatewayCredential(
  environment: NodeJS.ProcessEnv = process.env,
  requireToken = true,
): { readonly base_url: string; readonly bearer_token: string } {
  const baseUrl =
    environment['BAIJIAHAO_BROWSER_GATEWAY_BASE_URL']?.trim() || 'http://baijiahao-browser:9095';
  const parsed = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('BAIJIAHAO_BROWSER_GATEWAY_BASE_URL is invalid');
  }
  const token = environment['BAIJIAHAO_BROWSER_GATEWAY_TOKEN']?.trim() || '';
  if (requireToken && token.length < 32) {
    throw new PlatformAccountError(
      'PLATFORM_ACCOUNT_STATE_INVALID',
      'Baijiahao browser gateway is not configured',
    );
  }
  return Object.freeze({ base_url: parsed.toString(), bearer_token: token });
}

function unavailable(): PlatformAccountError {
  return new PlatformAccountError(
    'PLATFORM_ACCOUNT_STATE_INVALID',
    'Baijiahao browser gateway is unavailable',
    { reason: 'BROWSER_GATEWAY_UNAVAILABLE' },
  );
}

async function upstreamFailure(response: Response): Promise<PlatformAccountError> {
  const reason = await safeGatewayReason(response);
  return new PlatformAccountError(
    'PLATFORM_ACCOUNT_STATE_INVALID',
    'Baijiahao browser gateway rejected the operation',
    { reason, upstream_status: response.status },
  );
}

async function safeGatewayReason(response: Response): Promise<string> {
  try {
    const value = (await response.json()) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return 'BROWSER_GATEWAY_UNAVAILABLE';
    }
    const code = (value as Readonly<Record<string, unknown>>)['code'];
    if (typeof code !== 'string' || !SAFE_GATEWAY_ERROR_CODES.has(code)) {
      return 'BROWSER_GATEWAY_UNAVAILABLE';
    }
    return code === 'UNAUTHORIZED' ? 'GATEWAY_AUTH_FAILED' : code;
  } catch {
    return 'BROWSER_GATEWAY_UNAVAILABLE';
  }
}

const SAFE_GATEWAY_ERROR_CODES = new Set([
  'AUTH_REQUIRED',
  'BROWSER_GATEWAY_UNAVAILABLE',
  'CAPTCHA_REQUIRED',
  'CONFLICT',
  'PAGE_SIGNATURE_CHANGED',
  'SCHEMA_INVALID',
  'STATE_INVALID',
  'UNAUTHORIZED',
]);
