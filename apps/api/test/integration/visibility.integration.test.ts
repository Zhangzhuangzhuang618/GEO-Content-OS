import { InMemoryStorageAdapter } from '@geo-content-os/adapter-storage';
import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import {
  VisibilityService,
  VisibilityStateError,
  VisibilityValidationError,
  type VisibilityScope,
} from '../../src/modules/analytics/visibility/index.js';

const ANALYST = '11000000-0000-4000-8000-000000000129';
const VIEWER = '11000000-0000-4000-8000-000000000229';
const TENANT = '21000000-0000-4000-8000-000000000129';
const WORKSPACE = '31000000-0000-4000-8000-000000000129';
const SCOPE: VisibilityScope = {
  requestId: 'visibility-request-129',
  tenantId: TENANT,
  userId: ANALYST,
  workspaceId: WORKSPACE,
};

describe('visibility observations', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  let storage: InMemoryStorageAdapter;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 4 });
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`TRUNCATE users, tenants CASCADE`;
    await seed(database);
    storage = new InMemoryStorageAdapter('visibility-test');
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('records an observation and stores screenshot evidence in object storage', async () => {
    const database = requireClient(client);
    const service = new VisibilityService(database, storage);
    const screenshot = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const created = await service.record(
      SCOPE,
      {
        isCited: true,
        observedAt: '2026-07-15T08:00:00.000Z',
        platformCode: 'zhihu',
        queryText: '  GEO   Content OS  ',
        rankPosition: 2,
      },
      { body: screenshot, mimeType: 'image/png' },
    );

    expect(created).toMatchObject({
      isCited: true,
      platformCode: 'zhihu',
      queryText: 'GEO Content OS',
      rankPosition: 2,
    });
    expect(created.evidenceAssetId).not.toBeNull();
    const assets = await database<{ assetType: string; objectUri: string; workspaceId: string }[]>`
      SELECT asset_type AS "assetType", object_uri AS "objectUri",
        workspace_id AS "workspaceId"
      FROM media_assets
    `;
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ assetType: 'screenshot', workspaceId: WORKSPACE });
    const key = assets[0]!.objectUri.replace('memory://visibility-test/', '');
    expect(storage.readObject(key)).toEqual(screenshot);
    expect(
      await database`SELECT id FROM audit_events WHERE action='visibility_observation.created'`,
    ).toHaveLength(1);
  });

  it('imports observations atomically and returns daily trend aggregates', async () => {
    const database = requireClient(client);
    const service = new VisibilityService(database, storage);
    const created = await service.importRows(SCOPE, [
      observation('2026-07-14T01:00:00.000Z', true, 2),
      {
        ...observation('2026-07-14T18:00:00.000Z', false, 4),
        queryText: '  GEO   CONTENT OS ',
      },
      observation('2026-07-15T01:00:00.000Z', true, null),
    ]);
    expect(created).toHaveLength(3);
    expect(new Set(created.map((row) => row.queryHash)).size).toBe(1);

    const trend = await service.trend(SCOPE, { from: '2026-07-14', to: '2026-07-15' });
    expect(trend).toEqual([
      expect.objectContaining({
        averageRank: 3,
        bestRank: 2,
        citationCount: 1,
        citationRate: 0.5,
        day: '2026-07-14',
        observationCount: 2,
      }),
      expect.objectContaining({
        averageRank: null,
        bestRank: null,
        citationCount: 1,
        citationRate: 1,
        day: '2026-07-15',
        observationCount: 1,
      }),
    ]);
  });

  it('rejects invalid imports and users outside analyst/admin roles', async () => {
    const database = requireClient(client);
    const service = new VisibilityService(database, storage);
    await expect(
      service.importRows(SCOPE, [
        observation('2026-07-15T01:00:00.000Z', true, 1),
        { ...observation('2026-07-15T02:00:00.000Z', false, 2), platformCode: 'invalid' },
      ]),
    ).rejects.toBeInstanceOf(VisibilityValidationError);
    expect(await database`SELECT id FROM visibility_observations`).toHaveLength(0);

    await expect(
      service.record(
        { ...SCOPE, userId: VIEWER },
        observation('2026-07-15T01:00:00.000Z', true, 1),
      ),
    ).rejects.toBeInstanceOf(VisibilityStateError);
    expect(await database`SELECT id FROM visibility_observations`).toHaveLength(0);
  });
});

function observation(observedAt: string, isCited: boolean, rankPosition: number | null) {
  return {
    isCited,
    observedAt,
    platformCode: 'zhihu',
    queryText: 'Geo Content OS',
    rankPosition,
  };
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id,email,display_name,status) VALUES
      (${ANALYST}::uuid,'analyst-129@example.com','Analyst','active'),
      (${VIEWER}::uuid,'viewer-129@example.com','Viewer','active')
  `;
  await database`
    INSERT INTO tenants (id,name,slug,status)
    VALUES (${TENANT}::uuid,'Visibility Tenant','visibility-tenant','active')
  `;
  await database`
    INSERT INTO memberships (tenant_id,user_id,role_code,status) VALUES
      (${TENANT}::uuid,${ANALYST}::uuid,'analyst','active'),
      (${TENANT}::uuid,${VIEWER}::uuid,'viewer','active')
  `;
  await database`
    INSERT INTO workspaces (id,tenant_id,name,slug,timezone,status)
    VALUES (${WORKSPACE}::uuid,${TENANT}::uuid,'Visibility Workspace','visibility','UTC','active')
  `;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('PostgreSQL test client is not initialized');
  return client;
}
