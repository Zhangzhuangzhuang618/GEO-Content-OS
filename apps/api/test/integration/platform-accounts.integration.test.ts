import {
  CredentialEnvelopeService,
  LocalCredentialKms,
} from '@geo-content-os/security/credentials';
import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import { randomBytes } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import {
  PlatformAccountService,
  type PlatformAccountConnector,
  type PlatformAccountScope,
} from '../../src/modules/publishing/accounts/index.js';

const USER_ID = '11000000-0000-4000-8000-000000000123';
const OTHER_USER_ID = '12000000-0000-4000-8000-000000000123';
const TENANT_ID = '21000000-0000-4000-8000-000000000123';
const WORKSPACE_ID = '31000000-0000-4000-8000-000000000123';
const OTHER_WORKSPACE_ID = '32000000-0000-4000-8000-000000000123';
const SECRET = 'platform-secret-123';

const SCOPE: PlatformAccountScope = { tenantId: TENANT_ID, userId: USER_ID };
const OTHER_SCOPE: PlatformAccountScope = { tenantId: TENANT_ID, userId: OTHER_USER_ID };

describe('platform accounts', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  let kms: LocalCredentialKms | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 4 });
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`
      TRUNCATE
        export_artifacts, publish_attempts, publish_jobs, media_assets, platform_accounts,
        workspace_memberships, projects, workspaces, audit_events, memberships, tenants, users
      CASCADE
    `;
    await seed(database);
    kms?.destroy();
    kms = new LocalCredentialKms('test-v1', { 'test-v1': randomBytes(32) });
  });

  afterAll(async () => {
    kms?.destroy();
    await client?.end();
    await container?.stop();
  });

  it('connects, refreshes, tests and disables an account without exposing credentials', async () => {
    const database = requireClient(client);
    const service = createService(database, requireKms(kms));
    const connected = await service.create(
      SCOPE,
      {
        credential: { access_token: SECRET },
        display_name: 'Official Site',
        platform_code: 'official_site',
        publish_mode: 'api',
        timezone: 'Asia/Shanghai',
        workspace_id: WORKSPACE_ID,
      },
      { requestId: 'req-account-connect' },
    );

    expect(connected).toMatchObject({
      capabilities: { publish: true },
      platform_code: 'official_site',
      status: 'active',
      version: 1,
      workspace_id: WORKSPACE_ID,
    });
    expect(JSON.stringify(connected)).not.toContain(SECRET);
    expect(connected).not.toHaveProperty('credential');
    expect(connected).not.toHaveProperty('credential_ciphertext');

    const stored = await database<
      { credential_ciphertext: string; credential_key_version: string; version: number }[]
    >`SELECT credential_ciphertext, credential_key_version, version FROM platform_accounts WHERE id=${connected.id}::uuid`;
    expect(stored[0]).toMatchObject({ credential_key_version: 'test-v1', version: 1 });
    expect(stored[0]?.credential_ciphertext).not.toContain(SECRET);

    const listed = await service.list(SCOPE, { workspaceId: WORKSPACE_ID });
    expect(listed).toEqual([connected]);
    expect(JSON.stringify(listed)).not.toContain(SECRET);

    const refreshed = await service.refresh(SCOPE, connected.id, {}, 1, {
      requestId: 'req-account-refresh',
    });
    expect(refreshed).toMatchObject({ version: 2, status: 'active' });

    const tested = await service.test(SCOPE, connected.id, 2, {
      requestId: 'req-account-test',
    });
    expect(tested.account).toMatchObject({ version: 3, capabilities: { publish: true } });
    expect(tested.checkedAt).toBeInstanceOf(Date);

    await expect(
      service.disable(SCOPE, connected.id, 'stale request', 2, {
        requestId: 'req-account-stale',
      }),
    ).rejects.toMatchObject({
      code: 'PLATFORM_ACCOUNT_VERSION_CONFLICT',
    });

    const disabled = await service.disable(SCOPE, connected.id, 'rotated account', 3, {
      requestId: 'req-account-disable',
    });
    expect(disabled).toMatchObject({ status: 'disabled', version: 4 });
    await expect(
      service.test(SCOPE, connected.id, 4, { requestId: 'req-account-disabled-test' }),
    ).rejects.toMatchObject({
      code: 'PLATFORM_ACCOUNT_STATE_INVALID',
    });

    const audits = await database<
      { action: string; after_json: Record<string, unknown>; before_json: unknown }[]
    >`SELECT action, before_json, after_json FROM audit_events WHERE resource_id=${connected.id}::uuid ORDER BY created_at,id`;
    expect(audits.map(({ action }) => action)).toEqual([
      'platform_account.connected',
      'platform_account.refreshed',
      'platform_account.capability_tested',
      'platform_account.disabled',
    ]);
    expect(JSON.stringify(audits)).not.toContain(SECRET);
    expect(audits[0]?.before_json).toBeNull();
  });

  it('enforces workspace scope for reads and writes', async () => {
    const database = requireClient(client);
    const service = createService(database, requireKms(kms));
    const connected = await service.create(
      SCOPE,
      {
        credential: { access_token: SECRET },
        display_name: 'Scoped Account',
        platform_code: 'zhihu',
        publish_mode: 'api',
        timezone: 'Asia/Shanghai',
        workspace_id: WORKSPACE_ID,
      },
      { requestId: 'req-account-scope' },
    );

    await expect(service.list(OTHER_SCOPE)).resolves.toEqual([]);
    await expect(
      service.test(OTHER_SCOPE, connected.id, 1, { requestId: 'req-account-denied' }),
    ).rejects.toMatchObject({
      code: 'PLATFORM_ACCOUNT_NOT_FOUND',
    });
    await expect(
      service.create(
        OTHER_SCOPE,
        {
          credential: { access_token: SECRET },
          display_name: 'Denied Account',
          platform_code: 'zhihu',
          publish_mode: 'api',
          timezone: 'Asia/Shanghai',
          workspace_id: WORKSPACE_ID,
        },
        { requestId: 'req-account-create-denied' },
      ),
    ).rejects.toMatchObject({
      code: 'PLATFORM_ACCOUNT_NOT_FOUND',
    });
  });
});

function createService(database: Sql, localKms: LocalCredentialKms): PlatformAccountService {
  const connector: PlatformAccountConnector = {
    async probe(input) {
      expect(input.credential).not.toBeNull();
      return {
        capabilities: { publish: true },
        providerAccountId: `${input.platformCode}-account`,
        publishMode: input.publishMode,
        scopes: ['content.publish'],
        status: 'active',
        tokenExpiresAt: new Date('2027-01-01T00:00:00.000Z'),
      };
    },
    async refresh(input) {
      expect(input.credential).toEqual({ access_token: SECRET });
      return {
        capabilities: { publish: true },
        providerAccountId: `${input.platformCode}-account`,
        publishMode: 'api',
        scopes: ['content.publish'],
        status: 'active',
        tokenExpiresAt: new Date('2027-06-01T00:00:00.000Z'),
      };
    },
  };
  return new PlatformAccountService(database, new CredentialEnvelopeService(localKms), connector);
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id,email,display_name,status) VALUES
      (${USER_ID}::uuid,'publisher-123@example.com','Publisher','active'),
      (${OTHER_USER_ID}::uuid,'other-publisher-123@example.com','Other Publisher','active')
  `;
  await database`
    INSERT INTO tenants (id,name,slug,status)
    VALUES (${TENANT_ID}::uuid,'Account Tenant','account-tenant-123','active')
  `;
  await database`
    INSERT INTO memberships (tenant_id,user_id,role_code,status) VALUES
      (${TENANT_ID}::uuid,${USER_ID}::uuid,'publisher','active'),
      (${TENANT_ID}::uuid,${OTHER_USER_ID}::uuid,'publisher','active')
  `;
  await database`
    INSERT INTO workspaces (id,tenant_id,name,slug,timezone,status) VALUES
      (${WORKSPACE_ID}::uuid,${TENANT_ID}::uuid,'Account Workspace','account-workspace','Asia/Shanghai','active'),
      (${OTHER_WORKSPACE_ID}::uuid,${TENANT_ID}::uuid,'Other Workspace','other-account-workspace','Asia/Shanghai','active')
  `;
  await database`
    INSERT INTO workspace_memberships (workspace_id,user_id,scope_json) VALUES
      (${WORKSPACE_ID}::uuid,${USER_ID}::uuid,'{}'::jsonb),
      (${OTHER_WORKSPACE_ID}::uuid,${OTHER_USER_ID}::uuid,'{}'::jsonb)
  `;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('PostgreSQL client is not initialized');
  return client;
}

function requireKms(kms: LocalCredentialKms | undefined): LocalCredentialKms {
  if (!kms) throw new Error('Local KMS is not initialized');
  return kms;
}
