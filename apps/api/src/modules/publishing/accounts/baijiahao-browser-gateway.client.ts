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

  public constructor(environment: NodeJS.ProcessEnv = process.env) {
    const configuration = readBaijiahaoBrowserGatewayCredential(environment, false);
    this.baseUrl = configuration.base_url;
    this.token = configuration.bearer_token || null;
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
    const timeout = setTimeout(() => controller.abort(), 15_000);
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
        throw unavailable();
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
  );
}
