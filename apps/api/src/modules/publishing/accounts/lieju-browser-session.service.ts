import type {
  BaijiahaoBrowserLoginView,
  BaijiahaoBrowserSessionView,
  LiejuBrowserLoginRequest,
} from '@geo-content-os/contracts';

import { resolveDatabaseClient, type DatabaseClientSource } from '../../../database/index.js';
import { PlatformAccountError } from './platform-account.errors.js';
import type { PlatformAccountScope } from './platform-account.types.js';
import type { LiejuBrowserGatewayClient } from './lieju-browser-gateway.client.js';

export class LiejuBrowserSessionService {
  public constructor(
    private readonly databaseSource: DatabaseClientSource,
    private readonly gateway: LiejuBrowserGatewayClient,
  ) {}

  private get database() {
    return resolveDatabaseClient(this.databaseSource);
  }

  public async status(
    scope: PlatformAccountScope,
    accountId: string,
  ): Promise<BaijiahaoBrowserSessionView> {
    await this.requireAccount(scope, accountId);
    return this.gateway.status(accountId);
  }

  public async login(
    scope: PlatformAccountScope,
    accountId: string,
    input: LiejuBrowserLoginRequest,
    expectedVersion: number,
  ): Promise<BaijiahaoBrowserLoginView> {
    const account = await this.requireAccount(scope, accountId);
    requireMutable(account, expectedVersion);
    return this.gateway.login(accountId, input);
  }

  public async reauthenticate(
    scope: PlatformAccountScope,
    accountId: string,
    input: LiejuBrowserLoginRequest,
    expectedVersion: number,
  ): Promise<BaijiahaoBrowserLoginView> {
    const account = await this.requireAccount(scope, accountId);
    requireMutable(account, expectedVersion);
    return this.gateway.reauthenticate(accountId, input);
  }

  private async requireAccount(scope: PlatformAccountScope, accountId: string) {
    const rows = await this.database<{ publishMode: string; status: string; version: number }[]>`
      SELECT publish_mode AS "publishMode",status,version
      FROM platform_accounts
      WHERE id=${accountId}::uuid AND tenant_id=${scope.tenantId}::uuid
        AND platform_code='lieju' AND deleted_at IS NULL
        AND has_project_scope_access(tenant_id,workspace_id,NULL,${scope.userId}::uuid)
      LIMIT 1
    `;
    const account = rows[0];
    if (!account) {
      throw new PlatformAccountError('PLATFORM_ACCOUNT_NOT_FOUND', 'Lieju account was not found');
    }
    return account;
  }
}

function requireMutable(
  account: { readonly publishMode: string; readonly status: string; readonly version: number },
  expectedVersion: number,
): void {
  if (account.version !== expectedVersion) {
    throw new PlatformAccountError(
      'PLATFORM_ACCOUNT_VERSION_CONFLICT',
      'Platform account version does not match',
    );
  }
  if (account.status === 'disabled' || account.publishMode !== 'api') {
    throw new PlatformAccountError(
      'PLATFORM_ACCOUNT_STATE_INVALID',
      'Only a non-disabled Lieju API account can start browser login',
    );
  }
}
