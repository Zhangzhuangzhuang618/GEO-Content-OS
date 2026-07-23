import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import { createHash } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import {
  AnalyticsQueryService,
  AnalyticsQueryStateError,
  AnalyticsQueryValidationError,
  type AnalyticsQueryCache,
  type AnalyticsQueryScope,
} from '../../src/modules/analytics/queries/index.js';
import { MetricRegistry } from '../../src/modules/analytics/repositories/index.js';

const ANALYST = '11000000-0000-4000-8000-000000000130';
const TENANT = '21000000-0000-4000-8000-000000000130';
const WORKSPACE = '31000000-0000-4000-8000-000000000130';
const PROJECT = '41000000-0000-4000-8000-000000000130';
const BRIEF = '51000000-0000-4000-8000-000000000130';
const PACKAGE_NEW = '61000000-0000-4000-8000-000000000130';
const PACKAGE_OLD = '61000000-0000-4000-8000-000000000230';
const VARIANT_SITE = '71000000-0000-4000-8000-000000000130';
const VARIANT_ZHIHU = '71000000-0000-4000-8000-000000000230';
const IMPORT = '81000000-0000-4000-8000-000000000130';
const ROLLED_BACK_IMPORT = '81000000-0000-4000-8000-000000000230';
const RUNNING_IMPORT = '81000000-0000-4000-8000-000000000330';
const SCOPE: AnalyticsQueryScope = {
  tenantId: TENANT,
  userId: ANALYST,
  workspaceId: WORKSPACE,
};

describe('analytics queries', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  let cache: TestCache;

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
    cache = new TestCache();
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('returns versioned overview and platform aggregates and excludes rolled-back batches', async () => {
    const service = createService(requireClient(client), cache);
    const filter = { from: '2026-07-01', to: '2026-07-31' };
    const overview = await service.overview(SCOPE, filter);
    expect(overview.methodologyVersion).toBe('analytics-methodology@1');
    expect(overview.dataUpdatedAt).not.toBeNull();
    expect(overview.metrics).toEqual([
      { aggregation: 'average', name: 'engagement_rate', unit: 'ratio', value: 0.2 },
      { aggregation: 'last', name: 'followers', unit: 'count', value: 12 },
      { aggregation: 'sum', name: 'impressions', unit: 'count', value: 175 },
    ]);
    expect(overview.visibility).toEqual({
      averageRank: 3,
      citationCount: 1,
      citationRate: 0.5,
      observationCount: 2,
    });

    const platforms = await service.platforms(SCOPE, filter);
    expect(platforms.platforms).toEqual([
      expect.objectContaining({
        metrics: expect.arrayContaining([
          { aggregation: 'sum', name: 'impressions', unit: 'count', value: 150 },
        ]),
        platformCode: 'official_site',
        visibility: expect.objectContaining({ citationRate: 1, observationCount: 1 }),
      }),
      expect.objectContaining({
        metrics: [{ aggregation: 'sum', name: 'impressions', unit: 'count', value: 25 }],
        platformCode: 'zhihu',
        visibility: expect.objectContaining({ citationRate: 0, observationCount: 1 }),
      }),
    ]);
  });

  it('paginates content attribution with a cursor bound to the query filters', async () => {
    const service = createService(requireClient(client), cache);
    const first = await service.contents(SCOPE, {
      from: '2026-07-01',
      limit: 1,
      to: '2026-07-31',
    });
    expect(first.items).toEqual([
      expect.objectContaining({
        metrics: expect.arrayContaining([
          { aggregation: 'sum', name: 'impressions', unit: 'count', value: 150 },
        ]),
        packageId: PACKAGE_NEW,
        variantId: VARIANT_SITE,
      }),
    ]);
    expect(first.nextCursor).not.toBeNull();

    const second = await service.contents(SCOPE, {
      cursor: first.nextCursor as string,
      from: '2026-07-01',
      limit: 1,
      to: '2026-07-31',
    });
    expect(second.items).toEqual([
      expect.objectContaining({ packageId: PACKAGE_OLD, variantId: VARIANT_ZHIHU }),
    ]);
    expect(second.nextCursor).toBeNull();
    await expect(
      service.contents(SCOPE, {
        cursor: first.nextCursor as string,
        from: '2026-07-02',
        limit: 1,
        to: '2026-07-31',
      }),
    ).rejects.toBeInstanceOf(AnalyticsQueryValidationError);
  });

  it('uses derived cache without bypassing authorization on cache hits', async () => {
    const database = requireClient(client);
    const service = createService(database, cache);
    const filter = { from: '2026-07-01', to: '2026-07-31' };
    const first = await service.overview(SCOPE, filter);
    await insertMetric(database, {
      date: '2026-07-20',
      importJobId: IMPORT,
      metricName: 'impressions',
      platformCode: 'official_site',
      value: 500,
      variantId: VARIANT_SITE,
    });
    const cached = await service.overview(SCOPE, filter);
    expect(cached).toEqual(first);
    expect(cache.hitCount).toBe(1);

    await database`
      INSERT INTO workspace_memberships (workspace_id,user_id,scope_json)
      VALUES (
        ${WORKSPACE}::uuid,
        ${ANALYST}::uuid,
        ${database.json({ project_ids: [], schema_version: 'workspace-scope@1' })}
      )
    `;
    const restricted = await service.overview(SCOPE, filter);
    expect(restricted.metrics.find((metric) => metric.name === 'impressions')?.value).toBe(0);
    expect(restricted.visibility.observationCount).toBe(0);

    await database`
      UPDATE memberships SET status='disabled'
      WHERE tenant_id=${TENANT}::uuid AND user_id=${ANALYST}::uuid
    `;
    await expect(service.overview(SCOPE, filter)).rejects.toBeInstanceOf(AnalyticsQueryStateError);
  });
});

class TestCache implements AnalyticsQueryCache {
  public hitCount = 0;
  private readonly values = new Map<string, string>();

  public async get(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    if (value !== null) this.hitCount += 1;
    return value;
  }

  public async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

function createService(database: Sql, queryCache: AnalyticsQueryCache): AnalyticsQueryService {
  return new AnalyticsQueryService(
    database,
    new MetricRegistry([
      { aggregation: 'sum', allowNegative: false, name: 'impressions', unit: 'count' },
      { aggregation: 'average', allowNegative: false, name: 'engagement_rate', unit: 'ratio' },
      { aggregation: 'last', allowNegative: false, name: 'followers', unit: 'count' },
    ]),
    queryCache,
    { cacheTtlSeconds: 60, methodologyVersion: 'analytics-methodology@1' },
  );
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id,email,display_name,status)
    VALUES (${ANALYST}::uuid,'analyst-130@example.com','Analyst','active')
  `;
  await database`
    INSERT INTO tenants (id,name,slug,status)
    VALUES (${TENANT}::uuid,'Analytics Query Tenant','analytics-query','active')
  `;
  await database`
    INSERT INTO memberships (tenant_id,user_id,role_code,status)
    VALUES (${TENANT}::uuid,${ANALYST}::uuid,'analyst','active')
  `;
  await database`
    INSERT INTO workspaces (id,tenant_id,name,slug,timezone,status)
    VALUES (${WORKSPACE}::uuid,${TENANT}::uuid,'Analytics Query Workspace','analytics-query','UTC','active')
  `;
  await database`
    INSERT INTO projects (id,tenant_id,workspace_id,name,owner_id,status)
    VALUES (${PROJECT}::uuid,${TENANT}::uuid,${WORKSPACE}::uuid,'Analytics Project',${ANALYST}::uuid,'active')
  `;
  await database`
    INSERT INTO briefs (
      id,tenant_id,workspace_id,project_id,title,objective,audience,
      platform_codes,constraints_json,created_by
    ) VALUES (
      ${BRIEF}::uuid,${TENANT}::uuid,${WORKSPACE}::uuid,${PROJECT}::uuid,
      'Analytics Brief','awareness','Analytics audience',ARRAY['official_site','zhihu']::varchar[],
      ${database.json({ schema_version: 'brief-constraints@1' })},${ANALYST}::uuid
    )
  `;
  await database`
    INSERT INTO content_packages (
      id,tenant_id,workspace_id,project_id,brief_id,status,created_by,created_at
    ) VALUES
      (${PACKAGE_NEW}::uuid,${TENANT}::uuid,${WORKSPACE}::uuid,${PROJECT}::uuid,${BRIEF}::uuid,'published',${ANALYST}::uuid,'2026-07-10T00:00:00Z'),
      (${PACKAGE_OLD}::uuid,${TENANT}::uuid,${WORKSPACE}::uuid,${PROJECT}::uuid,${BRIEF}::uuid,'published',${ANALYST}::uuid,'2026-07-09T00:00:00Z')
  `;
  await database`
    INSERT INTO content_variants (id,tenant_id,package_id,platform_code,status) VALUES
      (${VARIANT_SITE}::uuid,${TENANT}::uuid,${PACKAGE_NEW}::uuid,'official_site','published'),
      (${VARIANT_ZHIHU}::uuid,${TENANT}::uuid,${PACKAGE_OLD}::uuid,'zhihu','published')
  `;
  await database`
    INSERT INTO import_jobs (
      id,tenant_id,workspace_id,source,status,row_count,created_by
    ) VALUES
      (${IMPORT}::uuid,${TENANT}::uuid,${WORKSPACE}::uuid,'manual','succeeded',7,${ANALYST}::uuid),
      (${ROLLED_BACK_IMPORT}::uuid,${TENANT}::uuid,${WORKSPACE}::uuid,'manual','rolled_back',1,${ANALYST}::uuid),
      (${RUNNING_IMPORT}::uuid,${TENANT}::uuid,${WORKSPACE}::uuid,'manual','running',1,${ANALYST}::uuid)
  `;
  await insertMetric(database, {
    date: '2026-07-10',
    importJobId: IMPORT,
    metricName: 'impressions',
    platformCode: 'official_site',
    value: 100,
    variantId: VARIANT_SITE,
  });
  await insertMetric(database, {
    date: '2026-07-11',
    importJobId: IMPORT,
    metricName: 'impressions',
    platformCode: 'official_site',
    value: 50,
    variantId: VARIANT_SITE,
  });
  await insertMetric(database, {
    date: '2026-07-10',
    importJobId: IMPORT,
    metricName: 'engagement_rate',
    platformCode: 'official_site',
    value: 0.1,
    variantId: VARIANT_SITE,
  });
  await insertMetric(database, {
    date: '2026-07-11',
    importJobId: IMPORT,
    metricName: 'engagement_rate',
    platformCode: 'official_site',
    value: 0.3,
    variantId: VARIANT_SITE,
  });
  await insertMetric(database, {
    date: '2026-07-10',
    importJobId: IMPORT,
    metricName: 'followers',
    platformCode: 'official_site',
    value: 10,
    variantId: VARIANT_SITE,
  });
  await insertMetric(database, {
    date: '2026-07-11',
    importJobId: IMPORT,
    metricName: 'followers',
    platformCode: 'official_site',
    value: 12,
    variantId: VARIANT_SITE,
  });
  await insertMetric(database, {
    date: '2026-07-11',
    importJobId: IMPORT,
    metricName: 'impressions',
    platformCode: 'zhihu',
    value: 25,
    variantId: VARIANT_ZHIHU,
  });
  await insertMetric(database, {
    date: '2026-07-11',
    importJobId: ROLLED_BACK_IMPORT,
    metricName: 'impressions',
    platformCode: 'official_site',
    value: 999,
    variantId: VARIANT_SITE,
  });
  await insertMetric(database, {
    date: '2026-07-11',
    importJobId: RUNNING_IMPORT,
    metricName: 'impressions',
    platformCode: 'official_site',
    value: 777,
    variantId: VARIANT_SITE,
  });
  await database`
    INSERT INTO visibility_observations (
      tenant_id,workspace_id,platform_code,query_text,query_hash,
      observed_at,rank_position,is_cited
    ) VALUES
      (${TENANT}::uuid,${WORKSPACE}::uuid,'official_site','GEO Content OS',${hash('site-observation')},'2026-07-10T08:00:00Z',2,true),
      (${TENANT}::uuid,${WORKSPACE}::uuid,'zhihu','GEO Content OS',${hash('zhihu-observation')},'2026-07-11T08:00:00Z',4,false)
  `;
}

async function insertMetric(
  database: Sql,
  input: {
    readonly date: string;
    readonly importJobId: string;
    readonly metricName: string;
    readonly platformCode: string;
    readonly value: number;
    readonly variantId: string;
  },
): Promise<void> {
  const dimension = hash(JSON.stringify(input));
  await database`
    INSERT INTO metric_records (
      tenant_id,workspace_id,import_job_id,platform_code,variant_id,
      metric_date,metric_name,metric_value,source,dimension_hash
    ) VALUES (
      ${TENANT}::uuid,${WORKSPACE}::uuid,${input.importJobId}::uuid,
      ${input.platformCode},${input.variantId}::uuid,${input.date}::date,
      ${input.metricName},${input.value},'manual',${dimension}
    )
  `;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('PostgreSQL test client is not initialized');
  return client;
}
