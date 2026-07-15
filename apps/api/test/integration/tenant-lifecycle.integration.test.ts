import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import { OutboxWriter } from '../../src/modules/outbox/index.js';
import {
  TenantLifecycleAccessError,
  TenantLifecycleService,
  type TenantLifecycleScope,
} from '../../src/modules/tenant-lifecycle/index.js';

const OWNER = '1e000000-0000-4000-8000-000000000134';
const VIEWER = '1e000000-0000-4000-8000-000000000234';
const TENANT = '2e000000-0000-4000-8000-000000000134';
const WORKSPACE = '3e000000-0000-4000-8000-000000000134';
const SCOPE: TenantLifecycleScope = {
  requestId: 'tenant-lifecycle-t134',
  tenantId: TENANT,
  userId: OWNER,
};

describe('tenant lifecycle', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 4 });
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`TRUNCATE users, tenants CASCADE`;
    await seed(database);
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('creates export job, outbox event, and required audit in one transaction', async () => {
    const database = requireClient(client);
    const service = new TenantLifecycleService(database, new OutboxWriter(database));
    const job = await database.begin((transaction) => service.requestExport(transaction, SCOPE));
    expect(job).toMatchObject({ requestedBy: OWNER, status: 'queued', tenantId: TENANT });
    expect(
      await database`
        SELECT id FROM outbox_events
        WHERE aggregate_id = ${job.id} AND event_type = 'lifecycle.tenant.export_requested.v1'
      `,
    ).toHaveLength(1);
    expect(
      await database`
        SELECT id FROM audit_events
        WHERE resource_id = ${job.id} AND action = 'tenant_export.requested'
      `,
    ).toHaveLength(1);
  });

  it('returns a no-mutation dry run and archives only after a successful export', async () => {
    const database = requireClient(client);
    const service = new TenantLifecycleService(database, new OutboxWriter(database));
    const job = await database.begin((transaction) => service.requestExport(transaction, SCOPE));
    const plan = await service.dryRunDeletion(SCOPE);
    expect(plan.tenantId).toBe(TENANT);
    expect(plan.rowCounts['memberships']).toBe(2);
    expect(plan.rowCounts['tenant_export_jobs']).toBe(1);
    expect(plan.totalRows).toBeGreaterThanOrEqual(5);
    expect(await database`SELECT status FROM tenants WHERE id = ${TENANT}`).toEqual([
      { status: 'active' },
    ]);

    await database`
      UPDATE tenant_export_jobs
      SET status='succeeded', object_uri='s3://tenant-exports/export.enc',
        manifest_hash=${'a'.repeat(64)}, expires_at=now() + INTERVAL '7 days'
      WHERE id=${job.id}
    `;
    await database.begin((transaction) =>
      service.archiveForDeletion(transaction, SCOPE, job.id, 'tenant-lifecycle'),
    );
    expect(
      await database`SELECT status, deleted_at IS NOT NULL AS deleted FROM tenants WHERE id=${TENANT}`,
    ).toEqual([{ deleted: true, status: 'archived' }]);
    expect(
      await database`SELECT id FROM audit_events WHERE action='tenant.deletion_archived'`,
    ).toHaveLength(1);
  });

  it('rejects non-owner lifecycle access without creating jobs', async () => {
    const database = requireClient(client);
    const service = new TenantLifecycleService(database, new OutboxWriter(database));
    await expect(
      database.begin((transaction) =>
        service.requestExport(transaction, { ...SCOPE, userId: VIEWER }),
      ),
    ).rejects.toBeInstanceOf(TenantLifecycleAccessError);
    expect(await database`SELECT id FROM tenant_export_jobs`).toHaveLength(0);
  });
});

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id,email,display_name,status) VALUES
      (${OWNER},'lifecycle-owner@example.com','Lifecycle Owner','active'),
      (${VIEWER},'lifecycle-viewer@example.com','Lifecycle Viewer','active')
  `;
  await database`
    INSERT INTO tenants (id,name,slug,status)
    VALUES (${TENANT},'Tenant Lifecycle','tenant-lifecycle','active')
  `;
  await database`
    INSERT INTO memberships (tenant_id,user_id,role_code,status) VALUES
      (${TENANT},${OWNER},'tenant_owner','active'),
      (${TENANT},${VIEWER},'viewer','active')
  `;
  await database`
    INSERT INTO workspaces (id,tenant_id,name,slug,timezone,status)
    VALUES (${WORKSPACE},${TENANT},'Lifecycle Workspace','lifecycle','UTC','active')
  `;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Tenant lifecycle PostgreSQL client is not initialized');
  return client;
}
