import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import {
  AnalyticsRepository,
  MetricRegistry,
  type AnalyticsScope,
} from '../../src/modules/analytics/repositories/index.js';

const USER = '11000000-0000-4000-8000-000000000127';
const TENANT = '21000000-0000-4000-8000-000000000127';
const OTHER_TENANT = '21000000-0000-4000-8000-000000000227';
const WORKSPACE = '31000000-0000-4000-8000-000000000127';
const PROJECT = '41000000-0000-4000-8000-000000000127';
const BRIEF = '51000000-0000-4000-8000-000000000127';
const PACKAGE = '61000000-0000-4000-8000-000000000127';
const VARIANT = '71000000-0000-4000-8000-000000000127';
const VERSION = '81000000-0000-4000-8000-000000000127';
const ACCOUNT = '91000000-0000-4000-8000-000000000127';
const SCREENSHOT = 'a1000000-0000-4000-8000-000000000127';
const IMPORT = 'b1000000-0000-4000-8000-000000000127';
const METRIC = 'c1000000-0000-4000-8000-000000000127';
const OBSERVATION = 'd1000000-0000-4000-8000-000000000127';
const HASH = 'a'.repeat(64);

const SCOPE: AnalyticsScope = { tenantId: TENANT, userId: USER, workspaceId: WORKSPACE };

describe('analytics database', () => {
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

  it('installs analytics tables, deduplication, query, and usage indexes', async () => {
    const database = requireClient(client);
    const tables = await database<{ name: string }[]>`
      SELECT tablename AS name FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('import_jobs', 'metric_records', 'visibility_observations')
      ORDER BY tablename
    `;
    expect(tables.map((row) => row.name)).toEqual([
      'import_jobs',
      'metric_records',
      'visibility_observations',
    ]);
    const indexes = await database<{ name: string }[]>`
      SELECT indexname AS name FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'metric_records_dimension_uq',
          'visibility_observations_query_time_idx',
          'usage_ledger_package_time_idx'
        )
      ORDER BY indexname
    `;
    expect(indexes.map((row) => row.name)).toEqual([
      'metric_records_dimension_uq',
      'usage_ledger_package_time_idx',
      'visibility_observations_query_time_idx',
    ]);
  });

  it('queries scoped imports, metrics, visibility, and effective settled usage', async () => {
    const repository = new AnalyticsRepository(requireClient(client));
    await expect(repository.listImportJobs(SCOPE)).resolves.toMatchObject([{ id: IMPORT }]);
    await expect(
      repository.listMetrics(SCOPE, { from: '2026-07-01', to: '2026-07-31' }, 'impressions'),
    ).resolves.toMatchObject([{ id: METRIC, metricValue: '120.0000', variantId: VARIANT }]);
    await expect(repository.listVisibility(SCOPE, HASH)).resolves.toMatchObject([
      { evidenceAssetId: SCREENSHOT, id: OBSERVATION, rankPosition: 2 },
    ]);
    await expect(
      repository.summarizeUsage(SCOPE, new Date('2026-07-01'), new Date('2026-08-01')),
    ).resolves.toMatchObject([
      { costCategory: 'platform_api', costCents: 8, entryCount: 1, packageId: PACKAGE },
    ]);

    const foreign = { ...SCOPE, tenantId: OTHER_TENANT };
    await expect(repository.listImportJobs(foreign)).resolves.toEqual([]);
    await expect(
      repository.listMetrics(foreign, { from: '2026-07-01', to: '2026-07-31' }),
    ).resolves.toEqual([]);
    await expect(repository.listVisibility(foreign)).resolves.toEqual([]);
  });

  it('enforces dimension idempotency, scope consistency, and append-only facts', async () => {
    const database = requireClient(client);
    await expect(
      database`
        INSERT INTO metric_records (
          tenant_id, workspace_id, platform_code, metric_date, metric_name,
          metric_value, source, dimension_hash
        ) VALUES (
          ${TENANT}::uuid, ${WORKSPACE}::uuid, 'official_site', '2026-07-15',
          'impressions', 120, 'manual', ${HASH}
        )
      `,
    ).rejects.toThrow(/metric_records_dimension_uq/u);
    await expect(
      database`UPDATE metric_records SET metric_value = 1 WHERE id = ${METRIC}::uuid`,
    ).rejects.toThrow(/append-only/u);
    await expect(
      database`DELETE FROM visibility_observations WHERE id = ${OBSERVATION}::uuid`,
    ).rejects.toThrow(/append-only/u);
    await expect(
      database`
        INSERT INTO visibility_observations (
          tenant_id, workspace_id, platform_code, query_text, query_hash,
          observed_at, is_cited, evidence_asset_id
        ) VALUES (
          ${TENANT}::uuid, ${WORKSPACE}::uuid, 'official_site', 'query', ${'b'.repeat(64)},
          now(), false, ${ACCOUNT}::uuid
        )
      `,
    ).rejects.toThrow();
  });

  it('validates metric definitions and values without inventing a global metric list', () => {
    const registry = new MetricRegistry([
      { aggregation: 'sum', allowNegative: false, name: 'impressions', unit: 'count' },
      { aggregation: 'last', allowNegative: true, name: 'position_delta', unit: 'position' },
    ]);
    expect(registry.list().map((item) => item.name)).toEqual(['impressions', 'position_delta']);
    expect(() => registry.validateValue('impressions', -1)).toThrow('Metric value is invalid');
    expect(() => registry.validateValue('unknown', 1)).toThrow('Metric is not registered');
    expect(
      () =>
        new MetricRegistry([
          { aggregation: 'sum', allowNegative: false, name: 'impressions', unit: 'count' },
          { aggregation: 'sum', allowNegative: false, name: 'impressions', unit: 'count' },
        ]),
    ).toThrow('Metric registry definition is invalid');
  });
});

async function seed(database: Sql): Promise<void> {
  await database`INSERT INTO users (id,email,display_name,status) VALUES (${USER}::uuid,'analyst@example.com','Analyst','active')`;
  await database`
    INSERT INTO tenants (id,name,slug,status) VALUES
      (${TENANT}::uuid,'Analytics Tenant','analytics-tenant','active'),
      (${OTHER_TENANT}::uuid,'Other Analytics','other-analytics','active')
  `;
  await database`INSERT INTO memberships (tenant_id,user_id,role_code,status) VALUES (${TENANT}::uuid,${USER}::uuid,'analyst','active')`;
  await database`INSERT INTO workspaces (id,tenant_id,name,slug,timezone,status) VALUES (${WORKSPACE}::uuid,${TENANT}::uuid,'Analytics Workspace','analytics','UTC','active')`;
  await database`INSERT INTO projects (id,tenant_id,workspace_id,name,owner_id,status) VALUES (${PROJECT}::uuid,${TENANT}::uuid,${WORKSPACE}::uuid,'Analytics Project',${USER}::uuid,'active')`;
  await database`
    INSERT INTO briefs (id,tenant_id,workspace_id,project_id,title,objective,audience,platform_codes,constraints_json,created_by)
    VALUES (${BRIEF}::uuid,${TENANT}::uuid,${WORKSPACE}::uuid,${PROJECT}::uuid,'Analytics Brief','awareness','Enterprise analytics audience',ARRAY['official_site']::varchar[],${database.json({ schema_version: 'brief-constraints@1' })},${USER}::uuid)
  `;
  await database`INSERT INTO content_packages (id,tenant_id,workspace_id,project_id,brief_id,status,created_by) VALUES (${PACKAGE}::uuid,${TENANT}::uuid,${WORKSPACE}::uuid,${PROJECT}::uuid,${BRIEF}::uuid,'published',${USER}::uuid)`;
  await database`INSERT INTO content_variants (id,tenant_id,package_id,platform_code,status) VALUES (${VARIANT}::uuid,${TENANT}::uuid,${PACKAGE}::uuid,'official_site','published')`;
  await database`
    INSERT INTO content_versions (id,tenant_id,package_id,variant_id,version_no,schema_version,content_json,content_hash,created_by)
    VALUES (${VERSION}::uuid,${TENANT}::uuid,${PACKAGE}::uuid,${VARIANT}::uuid,1,'content-document@1',${database.json({ schema_version: 'content-document@1' })},${HASH},${USER}::uuid)
  `;
  await database`UPDATE content_variants SET current_content_version_id=${VERSION}::uuid WHERE id=${VARIANT}::uuid`;
  await database`
    INSERT INTO platform_accounts (id,tenant_id,workspace_id,platform_code,display_name,scopes,capabilities_json,publish_mode,status,timezone)
    VALUES (${ACCOUNT}::uuid,${TENANT}::uuid,${WORKSPACE}::uuid,'official_site','Site',ARRAY['metrics'],${database.json({})},'api','active','UTC')
  `;
  await database`
    INSERT INTO media_assets (id,tenant_id,workspace_id,project_id,asset_type,object_uri,content_hash,mime_type,size_bytes,metadata_json,created_by)
    VALUES (${SCREENSHOT}::uuid,${TENANT}::uuid,${WORKSPACE}::uuid,${PROJECT}::uuid,'screenshot','s3://analytics/evidence.png',${HASH},'image/png',100,${database.json({})},${USER}::uuid)
  `;
  await database`
    INSERT INTO import_jobs (id,tenant_id,workspace_id,source,file_uri,content_hash,status,row_count,created_by)
    VALUES (${IMPORT}::uuid,${TENANT}::uuid,${WORKSPACE}::uuid,'csv','s3://analytics/metrics.csv',${HASH},'succeeded',1,${USER}::uuid)
  `;
  await database`
    INSERT INTO metric_records (id,tenant_id,workspace_id,import_job_id,platform_code,account_id,variant_id,metric_date,metric_name,metric_value,source,dimension_hash)
    VALUES (${METRIC}::uuid,${TENANT}::uuid,${WORKSPACE}::uuid,${IMPORT}::uuid,'official_site',${ACCOUNT}::uuid,${VARIANT}::uuid,'2026-07-15','impressions',120,'csv',${HASH})
  `;
  await database`
    INSERT INTO visibility_observations (id,tenant_id,workspace_id,platform_code,query_text,query_hash,observed_at,rank_position,is_cited,evidence_asset_id)
    VALUES (${OBSERVATION}::uuid,${TENANT}::uuid,${WORKSPACE}::uuid,'official_site','GEO Content OS',${HASH},'2026-07-15T08:00:00Z',2,true,${SCREENSHOT}::uuid)
  `;
  await database`
    INSERT INTO usage_ledger (tenant_id,workspace_id,project_id,package_id,variant_id,request_id,cost_category,provider,quantity,unit,cost_cents,currency,status,created_at)
    VALUES (${TENANT}::uuid,${WORKSPACE}::uuid,${PROJECT}::uuid,${PACKAGE}::uuid,${VARIANT}::uuid,'analytics-request-127','platform_api','official_site',1,'request',10,'CNY','estimated','2026-07-15T08:00:00Z')
  `;
  await database`
    INSERT INTO usage_ledger (tenant_id,workspace_id,project_id,package_id,variant_id,request_id,cost_category,provider,quantity,unit,cost_cents,currency,status,created_at)
    VALUES (${TENANT}::uuid,${WORKSPACE}::uuid,${PROJECT}::uuid,${PACKAGE}::uuid,${VARIANT}::uuid,'analytics-request-127','platform_api','official_site',1,'request',8,'CNY','settled','2026-07-15T08:01:00Z')
  `;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('PostgreSQL test client is not initialized');
  return client;
}
