import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import { createHash } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import {
  MetricsImportService,
  MetricsImportStateError,
  type MetricsImportScope,
} from '../../src/modules/analytics/imports/index.js';
import { MetricRegistry } from '../../src/modules/analytics/repositories/index.js';
import { OutboxWriter } from '../../src/modules/outbox/index.js';

const ANALYST = '11000000-0000-4000-8000-000000000128';
const VIEWER = '11000000-0000-4000-8000-000000000228';
const TENANT = '21000000-0000-4000-8000-000000000128';
const WORKSPACE = '31000000-0000-4000-8000-000000000128';
const PROJECT = '41000000-0000-4000-8000-000000000128';
const BRIEF = '51000000-0000-4000-8000-000000000128';
const PACKAGE = '61000000-0000-4000-8000-000000000128';
const VARIANT = '71000000-0000-4000-8000-000000000128';
const ACCOUNT = '91000000-0000-4000-8000-000000000128';
const FILE_HASH = createHash('sha256').update('metrics csv').digest('hex');
const SCOPE: MetricsImportScope = {
  requestId: 'metrics-import-request-128',
  tenantId: TENANT,
  userId: ANALYST,
  workspaceId: WORKSPACE,
};

describe('metrics import', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 4 });
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`
      TRUNCATE visibility_observations, metric_records, import_jobs, export_artifacts,
        publish_attempts, publish_jobs, media_assets, platform_accounts, usage_ledger,
        ai_citations, content_block_locks, content_blocks, content_versions,
        content_variants, content_packages, fact_sources, facts, embeddings, source_chunks,
        ingest_jobs, brief_sources, brief_keywords, briefs, source_documents,
        topic_candidates, generation_runs, keywords, keyword_sets, brand_profiles,
        workspace_memberships, projects, workspaces, audit_events, outbox_events,
        support_access_grants, idempotency_records, password_reset_tokens, invitations,
        sessions, platform_roles, memberships, tenants, users CASCADE
    `;
    await seed(database);
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('queues one CSV import and its outbox event atomically by content hash', async () => {
    const database = requireClient(client);
    const service = createService(database);
    const input = {
      contentHash: FILE_HASH,
      objectKey: 'tenants/128/imports/metrics.csv',
      objectUri: 's3://metrics/import.csv',
    };
    const [first, replay] = await Promise.all([
      database.begin((transaction) => service.queueCsv(transaction, SCOPE, input)),
      database.begin((transaction) => service.queueCsv(transaction, SCOPE, input)),
    ]);
    expect(replay.id).toBe(first.id);
    expect(await database`SELECT id FROM import_jobs`).toHaveLength(1);
    expect(
      await database`SELECT id FROM outbox_events WHERE event_type='analytics.metrics.import_requested.v1'`,
    ).toHaveLength(1);
    expect(
      await database`SELECT id FROM audit_events WHERE action='metrics_import.queued'`,
    ).toHaveLength(1);
  });

  it('imports valid rows, deduplicates dimensions, records row errors, and rolls back logically', async () => {
    const database = requireClient(client);
    const service = createService(database);
    const result = await database.begin((transaction) =>
      service.importRows(transaction, SCOPE, 'manual', [
        row(120),
        row(120),
        row(121),
        { ...row(1), metricName: 'unknown' },
      ]),
    );
    expect(result).toMatchObject({
      duplicateCount: 1,
      insertedCount: 1,
      status: 'succeeded',
    });
    expect(result.errors).toEqual([
      { index: 2, message: 'Dimension already exists with a different value' },
      { index: 3, message: 'Metric row is invalid' },
    ]);
    expect(await database`SELECT id FROM metric_records`).toHaveLength(1);
    const jobs = await database<{ error: unknown; rowCount: number; status: string }[]>`
      SELECT error_json AS error, row_count AS "rowCount", status FROM import_jobs
    `;
    expect(jobs[0]).toMatchObject({ rowCount: 2, status: 'succeeded' });
    expect(jobs[0]?.error).toMatchObject({ schema_version: 'import-error@1' });

    await database.begin((transaction) =>
      service.rollback(transaction, SCOPE, result.importJobId, 'duplicate source batch'),
    );
    expect(await database`SELECT status FROM import_jobs`).toEqual([{ status: 'rolled_back' }]);
    expect(await database`SELECT id FROM metric_records`).toHaveLength(1);
    expect(
      await database`
        SELECT metric.id
        FROM metric_records AS metric
        JOIN import_jobs AS job ON job.id=metric.import_job_id AND job.tenant_id=metric.tenant_id
        WHERE job.status <> 'rolled_back'
      `,
    ).toHaveLength(0);
    await expect(
      database.begin((transaction) =>
        service.rollback(transaction, SCOPE, result.importJobId, 'repeat rollback'),
      ),
    ).rejects.toBeInstanceOf(MetricsImportStateError);
  });

  it('rejects users outside analyst/admin roles and preserves tenant scope', async () => {
    const database = requireClient(client);
    const service = createService(database);
    await expect(
      database.begin((transaction) =>
        service.importRows(transaction, { ...SCOPE, userId: VIEWER }, 'manual', [row(1)]),
      ),
    ).rejects.toBeInstanceOf(MetricsImportStateError);
    expect(await database`SELECT id FROM import_jobs`).toHaveLength(0);
  });
});

function createService(database: Sql): MetricsImportService {
  return new MetricsImportService(
    new OutboxWriter(database),
    new MetricRegistry([
      { aggregation: 'sum', allowNegative: false, name: 'impressions', unit: 'count' },
    ]),
  );
}

function row(metricValue: number) {
  return {
    accountId: ACCOUNT,
    metricDate: '2026-07-15',
    metricName: 'impressions',
    metricValue,
    platformCode: 'official_site',
    variantId: VARIANT,
  };
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id,email,display_name,status) VALUES
      (${ANALYST}::uuid,'analyst-128@example.com','Analyst','active'),
      (${VIEWER}::uuid,'viewer-128@example.com','Viewer','active')
  `;
  await database`INSERT INTO tenants (id,name,slug,status) VALUES (${TENANT}::uuid,'Metrics Tenant','metrics-tenant','active')`;
  await database`
    INSERT INTO memberships (tenant_id,user_id,role_code,status) VALUES
      (${TENANT}::uuid,${ANALYST}::uuid,'analyst','active'),
      (${TENANT}::uuid,${VIEWER}::uuid,'viewer','active')
  `;
  await database`INSERT INTO workspaces (id,tenant_id,name,slug,timezone,status) VALUES (${WORKSPACE}::uuid,${TENANT}::uuid,'Metrics Workspace','metrics','UTC','active')`;
  await database`INSERT INTO projects (id,tenant_id,workspace_id,name,owner_id,status) VALUES (${PROJECT}::uuid,${TENANT}::uuid,${WORKSPACE}::uuid,'Metrics Project',${ANALYST}::uuid,'active')`;
  await database`
    INSERT INTO briefs (id,tenant_id,workspace_id,project_id,title,objective,audience,platform_codes,constraints_json,created_by)
    VALUES (${BRIEF}::uuid,${TENANT}::uuid,${WORKSPACE}::uuid,${PROJECT}::uuid,'Metrics Brief','awareness','Enterprise metrics audience',ARRAY['official_site']::varchar[],${database.json({ schema_version: 'brief-constraints@1' })},${ANALYST}::uuid)
  `;
  await database`INSERT INTO content_packages (id,tenant_id,workspace_id,project_id,brief_id,status,created_by) VALUES (${PACKAGE}::uuid,${TENANT}::uuid,${WORKSPACE}::uuid,${PROJECT}::uuid,${BRIEF}::uuid,'published',${ANALYST}::uuid)`;
  await database`INSERT INTO content_variants (id,tenant_id,package_id,platform_code,status) VALUES (${VARIANT}::uuid,${TENANT}::uuid,${PACKAGE}::uuid,'official_site','published')`;
  await database`
    INSERT INTO platform_accounts (id,tenant_id,workspace_id,platform_code,display_name,scopes,capabilities_json,publish_mode,status,timezone)
    VALUES (${ACCOUNT}::uuid,${TENANT}::uuid,${WORKSPACE}::uuid,'official_site','Site',ARRAY['metrics'],${database.json({})},'api','active','UTC')
  `;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('PostgreSQL test client is not initialized');
  return client;
}
