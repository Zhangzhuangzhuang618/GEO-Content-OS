import type { PlatformCode } from '@geo-content-os/contracts';

export interface AccountCredentialProbe {
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly providerAccountId: string | null;
  readonly publishMode: 'api' | 'export' | 'manual';
  readonly scopes: readonly string[];
  readonly status: 'active' | 'reauth';
  readonly tokenExpiresAt: Date | null;
}

export interface PlatformAccountConnector {
  probe(input: {
    readonly credential: Readonly<Record<string, unknown>> | null;
    readonly platformCode: PlatformCode;
    readonly publishMode: 'api' | 'export' | 'manual';
  }): Promise<AccountCredentialProbe>;
  refresh(input: {
    readonly credential: Readonly<Record<string, unknown>>;
    readonly platformCode: PlatformCode;
  }): Promise<AccountCredentialProbe>;
}

export interface PlatformAccountScope {
  readonly tenantId: string;
  readonly userId: string;
}
export interface PlatformAccountAudit {
  readonly ip?: string;
  readonly requestId: string;
}
