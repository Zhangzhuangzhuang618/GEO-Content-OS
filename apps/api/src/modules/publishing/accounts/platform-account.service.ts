import type {
  CreatePlatformAccountRequest,
  PlatformAccountView,
  RefreshAccountRequest,
  UpdatePlatformAccountRequest,
} from '@geo-content-os/contracts';
import type { CredentialEnvelopeService } from '@geo-content-os/security/credentials';
import {
  LiejuDeliveryConfigSchema,
  LiejuPostingProfileSchema,
} from '@geo-content-os/adapter-platforms/lieju/delivery';
import type { TransactionSql } from 'postgres';
import {
  resolveDatabaseClient,
  type DatabaseClient,
  type DatabaseClientSource,
} from '../../../database/index.js';
import { readBaijiahaoBrowserGatewayCredential } from './baijiahao-browser-gateway.client.js';
import { readSohuBrowserGatewayCredential } from './sohu-browser-gateway.client.js';
import { readLiejuBrowserGatewayCredential } from './lieju-browser-gateway.client.js';
import { PlatformAccountError } from './platform-account.errors.js';
import type {
  PlatformAccountAudit,
  PlatformAccountConnector,
  PlatformAccountScope,
} from './platform-account.types.js';

type Client = DatabaseClient | TransactionSql;
interface Row {
  readonly capabilities_json: Readonly<Record<string, unknown>>;
  readonly created_at: Date | string;
  readonly credential_ciphertext: string | null;
  readonly credential_key_version: string | null;
  readonly display_name: string;
  readonly id: string;
  readonly platform_code: PlatformAccountView['platform_code'];
  readonly provider_account_id: string | null;
  readonly publishing_url: string | null;
  readonly publish_mode: PlatformAccountView['publish_mode'];
  readonly scopes: readonly string[];
  readonly status: PlatformAccountView['status'];
  readonly tenant_id: string;
  readonly timezone: string;
  readonly token_expires_at: Date | string | null;
  readonly updated_at: Date | string;
  readonly version: number;
  readonly workspace_id: string;
}

export class PlatformAccountService {
  public constructor(
    private readonly databaseSource: DatabaseClientSource,
    private readonly credentials: CredentialEnvelopeService,
    private readonly connector: PlatformAccountConnector,
  ) {}

  private get database() {
    return resolveDatabaseClient(this.databaseSource);
  }
  public async create(
    scope: PlatformAccountScope,
    input: CreatePlatformAccountRequest,
    audit: PlatformAccountAudit,
  ): Promise<PlatformAccountView> {
    return this.database.begin((transaction) =>
      this.createInTransaction(transaction, scope, input, audit),
    );
  }
  public async createInTransaction(
    tx: TransactionSql,
    scope: PlatformAccountScope,
    input: CreatePlatformAccountRequest,
    audit: PlatformAccountAudit,
  ): Promise<PlatformAccountView> {
    await this.requireWorkspace(tx, scope, input.workspace_id);
    const credential = await accountCredential(
      input.platform_code,
      input.publish_mode,
      input.credential,
    );
    const probe = await this.connector.probe({
      credential,
      platformCode: input.platform_code,
      publishMode: input.publish_mode,
    });
    const stored = credential ? await encryptCredential(this.credentials, credential) : null;
    const rows = await tx<
      Row[]
    >`INSERT INTO platform_accounts (tenant_id,workspace_id,platform_code,provider_account_id,display_name,publishing_url,credential_ciphertext,credential_key_version,scopes,token_expires_at,capabilities_json,publish_mode,status,timezone) VALUES (${scope.tenantId}::uuid,${input.workspace_id}::uuid,${input.platform_code},${probe.providerAccountId},${input.display_name},${input.publishing_url ?? null},${stored?.credentialCiphertext ?? null},${stored?.credentialKeyVersion ?? null},${tx.array([...probe.scopes], 25)}::text[],${probe.tokenExpiresAt},${jsonbText(tx, probe.capabilities)}::jsonb,${probe.publishMode},${probe.status},${input.timezone}) RETURNING *`;
    const row = rows[0];
    if (!row) throw invalid();
    await this.audit(tx, scope, audit, 'platform_account.connected', row.id, null, safe(row));
    return map(row);
  }
  public async list(
    scope: PlatformAccountScope,
    filter: {
      readonly platformCode?: string;
      readonly status?: string;
      readonly workspaceId?: string;
    } = {},
  ): Promise<readonly PlatformAccountView[]> {
    const rows = await this.database<
      Row[]
    >`SELECT account.* FROM platform_accounts account WHERE account.tenant_id=${scope.tenantId}::uuid AND account.deleted_at IS NULL AND has_project_scope_access(account.tenant_id,account.workspace_id,NULL,${scope.userId}::uuid) AND (${filter.workspaceId ?? null}::uuid IS NULL OR account.workspace_id=${filter.workspaceId ?? null}::uuid) AND (${filter.platformCode ?? null}::varchar IS NULL OR account.platform_code=${filter.platformCode ?? null}) AND (${filter.status ?? null}::varchar IS NULL OR account.status=${filter.status ?? null}) ORDER BY account.platform_code,account.display_name,account.id`;
    return Object.freeze(rows.map(map));
  }
  public async refresh(
    scope: PlatformAccountScope,
    id: string,
    input: RefreshAccountRequest,
    version: number,
    audit: PlatformAccountAudit,
  ): Promise<PlatformAccountView> {
    return this.change(scope, id, version, audit, 'platform_account.refreshed', async (row, tx) => {
      const credential = await accountCredential(row.platform_code, 'api', input.credential, () =>
        this.decrypt(row),
      );
      if (!credential) throw invalid();
      const probe = await this.connector.refresh({ credential, platformCode: row.platform_code });
      const stored =
        input.credential || ['baijiahao', 'sohu', 'lieju'].includes(row.platform_code)
          ? await encryptCredential(this.credentials, credential)
          : null;
      const rows = await tx<
        Row[]
      >`UPDATE platform_accounts account SET provider_account_id=${probe.providerAccountId},scopes=${tx.array([...probe.scopes], 25)}::text[],token_expires_at=${probe.tokenExpiresAt},capabilities_json=${jsonbText(tx, probe.capabilities)}::jsonb,publish_mode=${probe.publishMode},status=${probe.status},credential_ciphertext=COALESCE(${stored?.credentialCiphertext ?? null},credential_ciphertext),credential_key_version=COALESCE(${stored?.credentialKeyVersion ?? null},credential_key_version),version=version+1 WHERE id=${id}::uuid AND tenant_id=${scope.tenantId}::uuid RETURNING *`;
      return requireRow(rows);
    });
  }
  public async update(
    scope: PlatformAccountScope,
    id: string,
    input: UpdatePlatformAccountRequest,
    version: number,
    audit: PlatformAccountAudit,
  ): Promise<PlatformAccountView> {
    return this.change(
      scope,
      id,
      version,
      audit,
      'platform_account.updated',
      async (row, tx) => {
        const credential = await accountCredential(
          row.platform_code,
          input.publish_mode,
          input.credential,
          () => this.decrypt(row),
        );
        const probe = await this.connector.probe({
          credential,
          platformCode: row.platform_code,
          publishMode: input.publish_mode,
        });
        const stored = credential ? await encryptCredential(this.credentials, credential) : null;
        const nextStatus = row.status === 'disabled' ? 'disabled' : probe.status;
        if (probe.publishMode !== 'api' || nextStatus !== 'active') {
          await disableAutomationPolicies(tx, scope.tenantId, id);
        }
        return requireRow(
          await tx<
            Row[]
          >`UPDATE platform_accounts account SET display_name=${input.display_name},publishing_url=${input.publishing_url === undefined ? row.publishing_url : input.publishing_url},timezone=${input.timezone},provider_account_id=${probe.providerAccountId},scopes=${tx.array([...probe.scopes], 25)}::text[],token_expires_at=${probe.tokenExpiresAt},capabilities_json=${jsonbText(tx, probe.capabilities)}::jsonb,publish_mode=${probe.publishMode},status=${nextStatus},credential_ciphertext=${stored?.credentialCiphertext ?? null},credential_key_version=${stored?.credentialKeyVersion ?? null},version=version+1 WHERE id=${id}::uuid AND tenant_id=${scope.tenantId}::uuid RETURNING *`,
        );
      },
      { allowDisabled: true },
    );
  }
  public async test(
    scope: PlatformAccountScope,
    id: string,
    version: number,
    audit: PlatformAccountAudit,
  ): Promise<{ readonly account: PlatformAccountView; readonly checkedAt: Date }> {
    const account = await this.change(
      scope,
      id,
      version,
      audit,
      'platform_account.capability_tested',
      async (row, tx) => {
        const probe = await this.connector.probe({
          credential: row.publish_mode === 'api' ? await this.decrypt(row) : null,
          platformCode: row.platform_code,
          publishMode: row.publish_mode,
        });
        const rows = await tx<
          Row[]
        >`UPDATE platform_accounts account SET capabilities_json=${jsonbText(tx, probe.capabilities)}::jsonb,status=${probe.status},version=version+1 WHERE id=${id}::uuid AND tenant_id=${scope.tenantId}::uuid RETURNING *`;
        return requireRow(rows);
      },
    );
    return { account, checkedAt: new Date() };
  }
  public async disable(
    scope: PlatformAccountScope,
    id: string,
    reason: string,
    version: number,
    audit: PlatformAccountAudit,
  ): Promise<PlatformAccountView> {
    return this.change(
      scope,
      id,
      version,
      audit,
      'platform_account.disabled',
      async (_row, tx) => {
        await this.requireNoActiveJobs(tx, scope, id);
        await disableAutomationPolicies(tx, scope.tenantId, id);
        return requireRow(
          await tx<
            Row[]
          >`UPDATE platform_accounts account SET status='disabled',version=version+1 WHERE id=${id}::uuid AND tenant_id=${scope.tenantId}::uuid RETURNING *`,
        );
      },
      { extra: { reason } },
    );
  }
  public async restore(
    scope: PlatformAccountScope,
    id: string,
    version: number,
    audit: PlatformAccountAudit,
  ): Promise<PlatformAccountView> {
    return this.change(
      scope,
      id,
      version,
      audit,
      'platform_account.restored',
      async (row, tx) => {
        if (row.status !== 'disabled') {
          throw new PlatformAccountError(
            'PLATFORM_ACCOUNT_STATE_INVALID',
            'Only disabled platform accounts can be restored',
          );
        }
        const probe = await this.connector.probe({
          credential: row.publish_mode === 'api' ? await this.decrypt(row) : null,
          platformCode: row.platform_code,
          publishMode: row.publish_mode,
        });
        return requireRow(
          await tx<
            Row[]
          >`UPDATE platform_accounts account SET provider_account_id=${probe.providerAccountId},scopes=${tx.array([...probe.scopes], 25)}::text[],token_expires_at=${probe.tokenExpiresAt},capabilities_json=${jsonbText(tx, probe.capabilities)}::jsonb,status=${probe.status},version=version+1 WHERE id=${id}::uuid AND tenant_id=${scope.tenantId}::uuid RETURNING *`,
        );
      },
      { allowDisabled: true },
    );
  }
  public async remove(
    scope: PlatformAccountScope,
    id: string,
    version: number,
    audit: PlatformAccountAudit,
  ): Promise<PlatformAccountView> {
    return this.change(
      scope,
      id,
      version,
      audit,
      'platform_account.removed',
      async (_row, tx) => {
        await this.requireNoActiveJobs(tx, scope, id);
        await disableAutomationPolicies(tx, scope.tenantId, id);
        return requireRow(
          await tx<
            Row[]
          >`UPDATE platform_accounts account SET status='disabled',deleted_at=now(),version=version+1 WHERE id=${id}::uuid AND tenant_id=${scope.tenantId}::uuid RETURNING *`,
        );
      },
      { allowDisabled: true },
    );
  }
  private async change(
    scope: PlatformAccountScope,
    id: string,
    version: number,
    audit: PlatformAccountAudit,
    action: string,
    work: (row: Row, tx: TransactionSql) => Promise<Row>,
    options: {
      readonly allowDisabled?: boolean;
      readonly extra?: Readonly<Record<string, unknown>>;
    } = {},
  ): Promise<PlatformAccountView> {
    return this.database.begin(async (tx) => {
      const rows = await tx<
        Row[]
      >`SELECT account.* FROM platform_accounts account WHERE id=${id}::uuid AND tenant_id=${scope.tenantId}::uuid AND deleted_at IS NULL AND has_project_scope_access(account.tenant_id,account.workspace_id,NULL,${scope.userId}::uuid) FOR UPDATE`;
      const before = rows[0];
      if (!before) throw notFound();
      if (before.version !== version)
        throw new PlatformAccountError(
          'PLATFORM_ACCOUNT_VERSION_CONFLICT',
          'Platform account version does not match',
        );
      if (before.status === 'disabled' && !options.allowDisabled)
        throw new PlatformAccountError(
          'PLATFORM_ACCOUNT_STATE_INVALID',
          'Disabled platform account cannot be changed',
        );
      const after = await work(before, tx);
      await this.audit(tx, scope, audit, action, id, safe(before), {
        ...safe(after),
        ...options.extra,
      });
      return map(after);
    });
  }
  private async requireNoActiveJobs(tx: TransactionSql, scope: PlatformAccountScope, id: string) {
    const rows = await tx<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM publish_jobs WHERE tenant_id=${scope.tenantId}::uuid AND account_id=${id}::uuid AND status IN ('scheduled','publishing','cancel_requested')`;
    if ((rows[0]?.count ?? 0) > 0) {
      throw new PlatformAccountError(
        'PLATFORM_ACCOUNT_STATE_INVALID',
        'Platform account still has active publishing jobs',
      );
    }
  }
  private async decrypt(row: Row) {
    if (!row.credential_ciphertext || !row.credential_key_version) throw invalid();
    try {
      return JSON.parse(
        await this.credentials.decrypt({
          credentialCiphertext: row.credential_ciphertext,
          credentialKeyVersion: row.credential_key_version,
        }),
      ) as Readonly<Record<string, unknown>>;
    } catch {
      throw invalid();
    }
  }
  private async requireWorkspace(client: Client, scope: PlatformAccountScope, workspaceId: string) {
    const rows = await client<
      { ok: number }[]
    >`SELECT 1 AS ok FROM workspaces WHERE id=${workspaceId}::uuid AND tenant_id=${scope.tenantId}::uuid AND status='active' AND deleted_at IS NULL AND has_project_scope_access(tenant_id,id,NULL,${scope.userId}::uuid)`;
    if (!rows[0]) throw notFound();
  }
  private async audit(
    tx: TransactionSql,
    scope: PlatformAccountScope,
    audit: PlatformAccountAudit,
    action: string,
    id: string,
    before: unknown,
    after: unknown,
  ) {
    await tx`INSERT INTO audit_events(tenant_id,actor_id,action,resource_type,resource_id,before_json,after_json,ip,request_id) VALUES(${scope.tenantId}::uuid,${scope.userId}::uuid,${action},'platform_account',${id}::uuid,${before ? jsonbText(tx, before) : null}::jsonb,${jsonbText(tx, after)}::jsonb,${audit.ip ?? null},${audit.requestId})`;
  }
}

async function accountCredential(
  platformCode: string,
  publishMode: 'api' | 'export' | 'manual',
  supplied?: Readonly<Record<string, unknown>>,
  fallback?: () => Promise<Readonly<Record<string, unknown>>>,
): Promise<Readonly<Record<string, unknown>> | null> {
  if (publishMode !== 'api') return null;
  if (platformCode === 'baijiahao') return readBaijiahaoBrowserGatewayCredential();
  if (platformCode === 'sohu') return readSohuBrowserGatewayCredential();
  if (platformCode === 'lieju') {
    const previous = fallback ? await fallback() : null;
    const raw = supplied ? mergeLiejuCredential(previous, supplied) : previous;
    if (!raw) return null;
    if (raw['delivery_method'] === 'official_api' || typeof raw['api_key'] === 'string') {
      const officialProfile = record(raw['posting_profile']) ?? raw;
      const parsed = LiejuDeliveryConfigSchema.parse({
        api_key: raw['api_key'],
        ...(raw['city_id'] === undefined ? {} : { city_id: raw['city_id'] }),
        delivery_method: 'official_api',
        ...(raw['endpoint'] === undefined ? {} : { endpoint: raw['endpoint'] }),
        ...(raw['fid'] === undefined ? {} : { fid: raw['fid'] }),
        mode: 'api',
        posting_profile: pickLiejuOfficialProfileFields(officialProfile),
        ...(raw['timeout_ms'] === undefined ? {} : { timeout_ms: raw['timeout_ms'] }),
      });
      if (parsed.mode !== 'api' || parsed.delivery_method !== 'official_api') throw invalid();
      return Object.freeze({
        api_key: parsed.api_key,
        city_id: parsed.city_id,
        delivery_method: parsed.delivery_method,
        endpoint: parsed.endpoint,
        fid: parsed.fid,
        posting_profile: parsed.posting_profile,
        timeout_ms: parsed.timeout_ms,
      });
    }
    const profileSource = raw['posting_profile'] ?? raw;
    const profile = LiejuPostingProfileSchema.parse(profileSource);
    return Object.freeze({
      ...readLiejuBrowserGatewayCredential(),
      delivery_method: 'browser_gateway',
      posting_profile: profile,
    });
  }
  if (supplied) return supplied;
  return fallback ? fallback() : null;
}

function mergeLiejuCredential(
  previous: Readonly<Record<string, unknown>> | null,
  supplied: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!previous) return supplied;
  const previousProfile = record(previous['posting_profile']);
  const suppliedProfile = record(supplied['posting_profile']) ?? pickLiejuProfileFields(supplied);
  return Object.freeze({
    ...previous,
    ...supplied,
    posting_profile: Object.freeze({ ...(previousProfile ?? {}), ...suppliedProfile }),
  });
}

function pickLiejuOfficialProfileFields(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const profile: Record<string, unknown> = {};
  for (const key of ['contact_name', 'mobile_phone', 'qq', 'wechat', 'zone_id']) {
    if (key in value) profile[key] = value[key];
  }
  return profile;
}

function pickLiejuProfileFields(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const profile: Record<string, unknown> = {};
  for (const key of [
    'address',
    'category_id',
    'contact_name',
    'mobile_phone',
    'qq',
    'street_id',
    'wechat',
    'zone_id',
  ]) {
    if (key in value) profile[key] = value[key];
  }
  return profile;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function jsonbText(client: Client, value: unknown) {
  return client.typed(JSON.stringify(value), 25);
}

async function disableAutomationPolicies(
  transaction: TransactionSql,
  tenantId: string,
  accountId: string,
): Promise<void> {
  await transaction`
    UPDATE official_site_automation_policies
    SET enabled=false,daily_enabled=false,version=version+1
    WHERE tenant_id=${tenantId}::uuid AND account_id=${accountId}::uuid AND enabled
  `;
  await transaction`
    UPDATE baijiahao_automation_policies
    SET enabled=false,daily_enabled=false,version=version+1
    WHERE tenant_id=${tenantId}::uuid AND account_id=${accountId}::uuid AND enabled
  `;
}
function map(row: Row): PlatformAccountView {
  return {
    capabilities: row.capabilities_json,
    created_at: isoDate(row.created_at),
    display_name: row.display_name,
    id: row.id,
    platform_code: row.platform_code,
    provider_account_id: row.provider_account_id,
    publishing_url: row.publishing_url,
    publish_mode: row.publish_mode,
    scopes: [...row.scopes],
    status: row.status,
    tenant_id: row.tenant_id,
    timezone: row.timezone,
    token_expires_at: row.token_expires_at ? isoDate(row.token_expires_at) : null,
    updated_at: isoDate(row.updated_at),
    version: row.version,
    workspace_id: row.workspace_id,
  };
}
function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
function safe(row: Row) {
  return map(row);
}
function requireRow(rows: Row[]) {
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}
function notFound() {
  return new PlatformAccountError('PLATFORM_ACCOUNT_NOT_FOUND', 'Platform account was not found');
}
function invalid() {
  return new PlatformAccountError(
    'PLATFORM_ACCOUNT_CREDENTIAL_INVALID',
    'Platform account credential is invalid',
  );
}

async function encryptCredential(
  credentials: CredentialEnvelopeService,
  value: Readonly<Record<string, unknown>>,
) {
  try {
    return await credentials.encrypt(JSON.stringify(value));
  } catch {
    throw invalid();
  }
}
