import {
  BrowserPlatformDailyScheduler,
  type DailyCitationPort,
  type DailyCitationRequest,
} from '@geo-content-os/worker-ai';
import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import { createHash } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import {
  loadRecommendationEvidence,
  resolveRecommendationContext,
} from '@geo-content-os/retrieval';
import { EditorialContextSchema } from '@geo-content-os/contracts';

const USER_ID = '12000000-0000-4000-8000-000000000154';
const TENANT_ID = '22000000-0000-4000-8000-000000000154';
const WORKSPACE_ID = '32000000-0000-4000-8000-000000000154';
const PROJECT_ID = '42000000-0000-4000-8000-000000000154';
const BRAND_ID = '52000000-0000-4000-8000-000000000154';
const KEYWORD_SET_ID = '62000000-0000-4000-8000-000000000154';
const KEYWORD_ID = '72000000-0000-4000-8000-000000000154';
const SOURCE_ID = '82000000-0000-4000-8000-000000000154';
const CHUNK_ID = '92000000-0000-4000-8000-000000000154';
const CERTIFICATE_SOURCE_ID = '83000000-0000-4000-8000-000000000154';
const CERTIFICATE_CHUNK_ID = '93000000-0000-4000-8000-000000000154';
const SOHU_ACCOUNT_ID = 'a1000000-0000-4000-8000-000000000154';
const LIEJU_ACCOUNT_ID = 'a2000000-0000-4000-8000-000000000154';
const SOHU_POLICY_ID = 'a3000000-0000-4000-8000-000000000154';
const LIEJU_POLICY_ID = 'a4000000-0000-4000-8000-000000000154';
const SOHU_RULE_ID = 'a5000000-0000-4000-8000-000000000154';
const LIEJU_RULE_ID = 'a6000000-0000-4000-8000-000000000154';
const DOUYIN_ACCOUNT_ONE_ID = 'a7000000-0000-4000-8000-000000000154';
const DOUYIN_ACCOUNT_TWO_ID = 'a8000000-0000-4000-8000-000000000154';
const DOUYIN_POLICY_ONE_ID = 'a9000000-0000-4000-8000-000000000154';
const DOUYIN_POLICY_TWO_ID = 'aa000000-0000-4000-8000-000000000154';
const DOUYIN_RULE_ID = 'ab000000-0000-4000-8000-000000000154';
const WRITER_PROMPT_ID = '25000000-0000-4000-8000-000000000008';
const QUALITY_PROMPT_ID = '25000000-0000-4000-8000-000000000007';

describe('browser-platform daily candidate retrieval', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 4 });
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`TRUNCATE TABLE users,tenants,outbox_events CASCADE`;
    await seed(database);
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('loads only explicitly bound current sources and rejects expired or inaccessible recommendation evidence', async () => {
    const database = requireClient(client);
    const companies = [
      { id: SOURCE_ID, legal_name: '广州测试搬家有限公司', source_document_ids: [SOURCE_ID] },
    ];
    const scope = {
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
    };
    const rows = await database.begin((transaction) =>
      loadRecommendationEvidence(transaction, scope, companies),
    );
    expect(rows.map((row) => row.sourceId)).toEqual([SOURCE_ID]);
    await expect(
      database.begin((transaction) =>
        loadRecommendationEvidence(transaction, { ...scope, projectId: BRAND_ID }, companies),
      ),
    ).rejects.toThrow('资料不可用');
    await database`UPDATE source_documents SET effective_to=CURRENT_DATE-1 WHERE id=${SOURCE_ID}::uuid`;
    await expect(
      database.begin((transaction) => loadRecommendationEvidence(transaction, scope, companies)),
    ).rejects.toThrow('广州测试搬家有限公司');
  });

  it('auto-binds primary sources and inherits services without certificates, keeping frozen evidence stable', async () => {
    const database = requireClient(client);
    const scope = {
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
    };
    const context = EditorialContextSchema.parse({
      account_id: LIEJU_ACCOUNT_ID,
      platform_code: 'lieju',
      policy_version: 1,
      schema_version: 'editorial-context@1',
      template_version: 'company-recommendation@1',
      style: 'company_recommendation',
      companies: [
        {
          id: SOURCE_ID,
          legal_name: '广州示例搬家有限公司',
          source_document_ids: [],
          evidence_mode: 'primary',
        },
        {
          id: CERTIFICATE_SOURCE_ID,
          legal_name: '广州另一搬家有限公司',
          source_document_ids: [],
          evidence_mode: 'inherit_primary',
        },
      ],
    });
    const resolved = await database.begin((tx) => resolveRecommendationContext(tx, scope, context));
    expect(resolved.companies[0]?.source_document_ids.sort()).toEqual(
      [SOURCE_ID, CERTIFICATE_SOURCE_ID].sort(),
    );
    expect(resolved.companies[1]?.source_document_ids).toEqual([SOURCE_ID]);
    expect(resolved).toMatchObject({
      evidence_resolved: true,
      primary_company_name: '广州示例搬家有限公司',
    });
    await expect(
      database.begin((tx) => loadRecommendationEvidence(tx, scope, resolved.companies)),
    ).resolves.toHaveLength(2);
    // Collected search pages are not automatically company-owned business evidence.
    await database`UPDATE source_documents SET source_type='url',mime_type='text/html',title='外部行业网页资料' WHERE id=${SOURCE_ID}::uuid`;
    const withoutExternal = await resolveRecommendationContext(database, scope, context);
    expect(withoutExternal.companies[0]?.source_document_ids).toEqual([CERTIFICATE_SOURCE_ID]);
    expect(withoutExternal.companies[1]?.source_document_ids).toEqual([]);
    await database`UPDATE source_documents SET title='广州示例搬家有限公司官网服务说明' WHERE id=${SOURCE_ID}::uuid`;
    expect(
      (await resolveRecommendationContext(database, scope, context)).companies[1]
        ?.source_document_ids,
    ).toEqual([SOURCE_ID]);
    await database`UPDATE source_documents SET source_type='txt',mime_type='text/plain',title='企业服务资料' WHERE id=${SOURCE_ID}::uuid`;
    await database`UPDATE source_documents SET effective_to=CURRENT_DATE-1 WHERE id=${SOURCE_ID}::uuid`;
    expect(await resolveRecommendationContext(database, scope, resolved)).toEqual(resolved);
    await expect(
      database.begin((tx) => loadRecommendationEvidence(tx, scope, resolved.companies)),
    ).rejects.toThrow('资料不可用');
    await expect(
      resolveRecommendationContext(database, { ...scope, workspaceId: BRAND_ID }, context),
    ).rejects.toThrow('唯一企业身份');
    context.companies[0]!.legal_name = '广州错误搬家有限公司';
    await expect(resolveRecommendationContext(database, scope, context)).rejects.toThrow('不一致');
  });

  it('requires certificate holder, authorization, active chunks and current validity for recommendations', async () => {
    const database = requireClient(client);
    const scope = {
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
    };
    const companies = [
      {
        id: SOURCE_ID,
        legal_name: '广州示例搬家有限公司',
        source_document_ids: [CERTIFICATE_SOURCE_ID],
      },
    ];
    const load = () =>
      database.begin((transaction) => loadRecommendationEvidence(transaction, scope, companies));
    expect((await load()).map((row) => row.sourceId)).toEqual([CERTIFICATE_SOURCE_ID]);
    companies[0]!.legal_name = '另一家公司';
    await expect(load()).rejects.toThrow('持证主体');
    companies[0]!.legal_name = '广州示例搬家有限公司';
    await database`UPDATE source_documents SET metadata_json=jsonb_set(metadata_json,'{article_use_allowed}','false') WHERE id=${CERTIFICATE_SOURCE_ID}::uuid`;
    await expect(load()).rejects.toThrow('资料不可用');
    await database`UPDATE source_documents SET metadata_json=jsonb_set(metadata_json,'{article_use_allowed}','true'),effective_to=CURRENT_DATE-1 WHERE id=${CERTIFICATE_SOURCE_ID}::uuid`;
    await expect(load()).rejects.toThrow('资料不可用');
    await database`UPDATE source_documents SET effective_to=NULL WHERE id=${CERTIFICATE_SOURCE_ID}::uuid`;
    await database`UPDATE source_chunks SET status='inactive' WHERE id=${CERTIFICATE_CHUNK_ID}::uuid`;
    await expect(load()).rejects.toThrow('资料不可用');
  });

  it('retrieves and freezes evidence independently for Sohu and Lieju candidates', async () => {
    const database = requireClient(client);
    const requests: DailyCitationRequest[] = [];
    const citations: DailyCitationPort = {
      retrieve: (input) => {
        requests.push(input);
        return Promise.resolve({
          citations: [
            { chunkId: CHUNK_ID, quoteText: '企业可核验服务资料', sourceId: SOURCE_ID },
            ...(input.authoritySourceIds?.includes(CERTIFICATE_SOURCE_ID)
              ? [
                  {
                    chunkId: CERTIFICATE_CHUNK_ID,
                    quoteText: '资料类型：企业证照\n证照名称：道路运输经营许可证',
                    sourceId: CERTIFICATE_SOURCE_ID,
                  },
                ]
              : []),
          ],
          contextHash: sha256(`context:${input.platformCode}`),
          degraded: false,
          queryHash: sha256(`query:${input.title}`),
        });
      },
    };
    const scheduler = new BrowserPlatformDailyScheduler(
      database,
      {
        qualityModelKey: 'deepseek-v4-pro',
        qualityPromptVersionId: QUALITY_PROMPT_ID,
        qualitySkillVersion: '1.0.0',
        rewriteModelKey: 'deepseek-v4-pro',
        writerPromptVersionId: WRITER_PROMPT_ID,
        writerSkillVersion: '1.0.0',
      },
      { tickMs: 30_000 },
      citations,
    );

    await scheduler.tick();

    expect(requests.map((request) => request.platformCode).sort()).toEqual(['lieju', 'sohu']);
    expect(
      requests.every(
        (request) =>
          request.keyword === '广州搬家' &&
          request.title.length > 0 &&
          request.angle.length > 0 &&
          request.objective.length > 0 &&
          request.audience.includes('广州搬家'),
      ),
    ).toBe(true);
    expect(
      requests.every((request) => request.authoritySourceIds?.[0] === CERTIFICATE_SOURCE_ID),
    ).toBe(true);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM brief_sources
        WHERE tenant_id=${TENANT_ID}::uuid AND source_document_id=${SOURCE_ID}::uuid
      `,
    ).toEqual([{ count: 2 }]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM brief_sources
        WHERE tenant_id=${TENANT_ID}::uuid
          AND source_document_id=${CERTIFICATE_SOURCE_ID}::uuid
      `,
    ).toEqual([{ count: 2 }]);
    expect(
      await database<
        {
          authorizedSourceIds: string[];
          cta: string | null;
          chunkId: string;
          platformCode: string;
          sourceId: string;
        }[]
      >`
        SELECT
          event.payload_json->'data'->'variant_runs'->0->>'platform_code' AS "platformCode",
          event.payload_json->'data'->'writer_input'->'brief'->'constraints'
            ->'authorized_certificate_source_ids' AS "authorizedSourceIds",
          event.payload_json->'data'->'writer_input'->'brief'->'constraints'
            ->>'cta' AS cta,
          event.payload_json->'data'->'writer_input'->'citations'->0->>'chunk_id' AS "chunkId",
          event.payload_json->'data'->'writer_input'->'citations'->0->>'source_id' AS "sourceId"
        FROM outbox_events AS event
        WHERE event.tenant_id=${TENANT_ID}::uuid
          AND event.event_type='content.package.generation_requested.v1'
        ORDER BY "platformCode"
      `,
    ).toEqual([
      {
        authorizedSourceIds: [CERTIFICATE_SOURCE_ID],
        cta: '通过页面联系方式咨询',
        chunkId: CHUNK_ID,
        platformCode: 'lieju',
        sourceId: SOURCE_ID,
      },
      {
        authorizedSourceIds: [CERTIFICATE_SOURCE_ID],
        cta: null,
        chunkId: CHUNK_ID,
        platformCode: 'sohu',
        sourceId: SOURCE_ID,
      },
    ]);
  });

  it.each([false, true])(
    'allows Lieju generation without optional evidence (regional=%s)',
    async (regional) => {
      const database = requireClient(client);
      if (regional)
        await database`INSERT INTO platform_account_content_policies
      (account_id,tenant_id,workspace_id,platform_code,regional_mode_enabled,created_by,updated_by)
      VALUES (${LIEJU_ACCOUNT_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,'lieju',true,${USER_ID}::uuid,${USER_ID}::uuid)`;
      await database`
      DELETE FROM source_chunks
      WHERE tenant_id=${TENANT_ID}::uuid AND source_document_id=${CERTIFICATE_SOURCE_ID}::uuid
    `;
      await database`
      DELETE FROM source_documents
      WHERE tenant_id=${TENANT_ID}::uuid AND id=${CERTIFICATE_SOURCE_ID}::uuid
    `;
      const requests: DailyCitationRequest[] = [];
      const scheduler = new BrowserPlatformDailyScheduler(
        database,
        {
          qualityModelKey: 'deepseek-v4-pro',
          qualityPromptVersionId: QUALITY_PROMPT_ID,
          qualitySkillVersion: '1.0.0',
          rewriteModelKey: 'deepseek-v4-pro',
          writerPromptVersionId: WRITER_PROMPT_ID,
          writerSkillVersion: '1.0.0',
        },
        { tickMs: 30_000 },
        {
          retrieve: (input) => {
            requests.push(input);
            return Promise.resolve({
              citations: [
                { chunkId: CHUNK_ID, quoteText: '企业可核验服务资料', sourceId: SOURCE_ID },
              ],
              contextHash: sha256(`context:${input.platformCode}`),
              degraded: false,
              queryHash: sha256(`query:${input.title}`),
            });
          },
        },
      );

      await scheduler.tick();

      expect(requests.map((request) => request.platformCode).sort()).toEqual(['lieju', 'sohu']);
      expect(requests.every((request) => request.authoritySourceIds?.length === 0)).toBe(true);
      expect(
        await database<{ hasEnterpriseEvidence: boolean; platformCode: string }[]>`
        SELECT
          event.payload_json->'data'->'variant_runs'->0->>'platform_code' AS "platformCode",
          event.payload_json->'data'->'writer_input'->'brief'->'constraints'
            ? 'enterprise_evidence' AS "hasEnterpriseEvidence"
        FROM outbox_events AS event
        WHERE event.tenant_id=${TENANT_ID}::uuid
          AND event.event_type='content.package.generation_requested.v1'
        ORDER BY "platformCode"
      `,
      ).toEqual([
        { hasEnterpriseEvidence: false, platformCode: 'lieju' },
        { hasEnterpriseEvidence: false, platformCode: 'sohu' },
      ]);
      if (regional) {
        await database`UPDATE browser_platform_automation_policies SET daily_candidate_limit=3
          WHERE id=${LIEJU_POLICY_ID}::uuid`;
        await database`UPDATE content_variants SET status='generation_failed'
          WHERE id IN (SELECT variant_id FROM browser_platform_daily_batch_items
            WHERE batch_id IN (SELECT id FROM browser_platform_daily_batches
              WHERE policy_id=${LIEJU_POLICY_ID}::uuid))`;
        await scheduler.tick();
        const slots =
          await database`SELECT i.regional_slot,i.status FROM browser_platform_daily_batch_items i
          JOIN browser_platform_daily_batches b ON b.id=i.batch_id
          WHERE b.policy_id=${LIEJU_POLICY_ID}::uuid ORDER BY i.candidate_no`;
        expect(slots.map((row) => row.regional_slot)).toEqual([1, 1]);
        expect(slots[0].status).toBe('retired');
        expect(
          (
            await database`SELECT regional_cursor FROM platform_account_content_policies
          WHERE account_id=${LIEJU_ACCOUNT_ID}::uuid`
          )[0].regional_cursor,
        ).toBe(1);
        await database`INSERT INTO browser_platform_daily_batches(tenant_id,policy_id,business_date)
          SELECT tenant_id,policy_id,business_date+1 FROM browser_platform_daily_batches
          WHERE policy_id=${LIEJU_POLICY_ID}::uuid`;
        const plans = await database`SELECT districts FROM regional_daily_plans
          WHERE account_id=${LIEJU_ACCOUNT_ID}::uuid ORDER BY business_date`;
        expect(plans.map((row) => row.districts)).toEqual([['越秀'], ['海珠']]);
      }
    },
  );

  it.each([false, true])(
    'reserves company-level Douyin topics and independent account regions (regional=%s)',
    async (regional) => {
      const database = requireClient(client);
      await database`
      UPDATE browser_platform_automation_policies SET enabled=false,daily_enabled=false
      WHERE tenant_id=${TENANT_ID}::uuid
    `;
      await database`
      UPDATE keywords SET platform_scope=ARRAY['sohu','lieju','douyin']::varchar[]
      WHERE id=${KEYWORD_ID}::uuid AND tenant_id=${TENANT_ID}::uuid
    `;
      await database`
      INSERT INTO platform_rule_versions(
        id,platform_code,version,rules_json,content_hash,status,created_by,published_at
      ) VALUES(
        ${DOUYIN_RULE_ID}::uuid,'douyin','9.0.0',
        ${database.json({ content_kind: 'image_note', schema_version: 'platform-rules@1' })},
        ${'d'.repeat(64)},'published',${USER_ID}::uuid,now()
      )
    `;
      await database`
      INSERT INTO platform_accounts(
        id,tenant_id,workspace_id,platform_code,provider_account_id,display_name,
        capabilities_json,publish_mode,status,timezone
      ) VALUES
        (
          ${DOUYIN_ACCOUNT_ONE_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,'douyin',
          'douyin-one-154','家庭搬家抖音号',${database.json({ publish: true })},
          'api','active','Asia/Shanghai'
        ),
        (
          ${DOUYIN_ACCOUNT_TWO_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,'douyin',
          'douyin-two-154','设备搬迁抖音号',${database.json({ publish: true })},
          'api','active','Asia/Shanghai'
        )
    `;
      await database`
      INSERT INTO browser_platform_automation_policies(
        id,tenant_id,workspace_id,project_id,account_id,platform_code,
        enabled,daily_enabled,daily_target_count,daily_candidate_limit,
        daily_generation_time,daily_schedule_times,account_positioning,
        content_voice,service_scopes,target_regions,topic_pool,created_by
      ) VALUES
        (
          ${DOUYIN_POLICY_ONE_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,
          ${PROJECT_ID}::uuid,${DOUYIN_ACCOUNT_ONE_ID}::uuid,'douyin',true,true,1,1,
          TIME '00:00',ARRAY[TIME '10:00'],'服务广州家庭客户',
          'enterprise_official',
          ARRAY['居民搬家'],ARRAY['广州'],ARRAY['高层小区家庭搬迁'],${USER_ID}::uuid
        ),
        (
          ${DOUYIN_POLICY_TWO_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,
          ${PROJECT_ID}::uuid,${DOUYIN_ACCOUNT_TWO_ID}::uuid,'douyin',true,true,1,1,
          TIME '00:00',ARRAY[TIME '10:00'],'服务广州企业客户',
          'frontline_mover',
          ARRAY['设备搬迁'],ARRAY['广州'],ARRAY['工厂设备搬迁'],${USER_ID}::uuid
        )
    `;
      if (regional)
        for (const accountId of [DOUYIN_ACCOUNT_ONE_ID, DOUYIN_ACCOUNT_TWO_ID]) {
          await database`INSERT INTO platform_account_content_policies
        (account_id,tenant_id,workspace_id,platform_code,regional_mode_enabled,created_by,updated_by)
        VALUES (${accountId}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,'douyin',true,${USER_ID}::uuid,${USER_ID}::uuid)`;
        }
      const requests: DailyCitationRequest[] = [];
      const scheduler = new BrowserPlatformDailyScheduler(
        database,
        {
          draftModelKey: 'deepseek-v4-flash',
          qualityModelKey: 'deepseek-v4-pro',
          qualityPromptVersionId: QUALITY_PROMPT_ID,
          qualitySkillVersion: '1.0.0',
          rewriteModelKey: 'deepseek-v4-pro',
          writerPromptVersionId: WRITER_PROMPT_ID,
          writerSkillVersion: '1.0.0',
        },
        { tickMs: 30_000 },
        {
          retrieve: (input) => {
            requests.push(input);
            return Promise.resolve({
              citations: [
                { chunkId: CHUNK_ID, quoteText: '企业可核验服务资料', sourceId: SOURCE_ID },
              ],
              contextHash: sha256(`context:${input.title}`),
              degraded: false,
              queryHash: sha256(`query:${input.title}`),
            });
          },
        },
      );

      await scheduler.tick();

      expect(requests).toHaveLength(2);
      const reservations = await database<
        { accountId: string; keyword: string; searchIntent: string }[]
      >`
      SELECT account_id AS "accountId",keyword_term::text AS keyword,
        search_intent AS "searchIntent"
      FROM douyin_topic_reservations
      WHERE tenant_id=${TENANT_ID}::uuid AND workspace_id=${WORKSPACE_ID}::uuid
      ORDER BY account_id
    `;
      expect(reservations).toHaveLength(2);
      expect(new Set(reservations.map((row) => `${row.keyword}:${row.searchIntent}`)).size).toBe(2);
      await expect(
        database`
        INSERT INTO douyin_topic_reservations (
          tenant_id,workspace_id,policy_id,account_id,batch_id,business_date,
          keyword_term,search_intent
        )
        SELECT tenant_id,workspace_id,policy_id,account_id,batch_id,business_date,
          keyword_term,search_intent
        FROM douyin_topic_reservations
        WHERE tenant_id=${TENANT_ID}::uuid
        ORDER BY created_at,id LIMIT 1
      `,
      ).rejects.toThrow(/douyin_topic_reservations_company_topic_uq/u);
      await expect(
        database`
        UPDATE browser_platform_automation_policies SET topic_pool=ARRAY[]::text[]
        WHERE id=${DOUYIN_POLICY_ONE_ID}::uuid AND tenant_id=${TENANT_ID}::uuid
      `,
      ).rejects.toThrow(/browser_platform_automation_policies_douyin_strategy_check/u);
      const frozenStrategies = await database<
        {
          accountId: string;
          contentVoice: string;
          positioning: string;
          selectedTopic: string;
          strategyHasContentVoice: boolean;
        }[]
      >`
      SELECT
        event.payload_json->'data'->'writer_input'->'brief'->'constraints'
          ->'target_accounts_by_code'->'douyin'->>'account_id' AS "accountId",
        event.payload_json->'data'->'writer_input'->'brief'->'constraints'
          ->'douyin_account_strategy'->>'account_positioning' AS positioning,
        event.payload_json->'data'->'writer_input'->'brief'->'constraints'
          ->'douyin_account_strategy'->>'selected_topic' AS "selectedTopic",
        event.payload_json->'data'->'writer_input'->'brief'->'constraints'
          ->>'douyin_content_voice' AS "contentVoice",
        event.payload_json->'data'->'writer_input'->'brief'->'constraints'
          ->'douyin_account_strategy' ? 'content_voice' AS "strategyHasContentVoice"
      FROM outbox_events AS event
      WHERE event.tenant_id=${TENANT_ID}::uuid
        AND event.event_type='content.package.generation_requested.v1'
      ORDER BY "accountId"
    `;
      expect(frozenStrategies).toEqual([
        {
          accountId: DOUYIN_ACCOUNT_ONE_ID,
          contentVoice: 'enterprise_official',
          positioning: '服务广州家庭客户',
          selectedTopic: regional ? '越秀高层小区家庭搬迁' : '高层小区家庭搬迁',
          strategyHasContentVoice: false,
        },
        {
          accountId: DOUYIN_ACCOUNT_TWO_ID,
          contentVoice: 'frontline_mover',
          positioning: '服务广州企业客户',
          selectedTopic: regional ? '越秀工厂设备搬迁' : '工厂设备搬迁',
          strategyHasContentVoice: false,
        },
      ]);
    },
  );
});

async function seed(database: Sql): Promise<void> {
  const evidence = '广州搬家服务按物品、楼层和通道情况核对执行条件。';
  await database`
    INSERT INTO users(id,email,display_name,status)
    VALUES(${USER_ID}::uuid,'browser-daily-154@example.com','Browser Daily','active')
  `;
  await database`
    INSERT INTO tenants(id,name,slug,status)
    VALUES(${TENANT_ID}::uuid,'Browser Daily Tenant','browser-daily-154','active')
  `;
  await database`
    INSERT INTO memberships(tenant_id,user_id,role_code,status)
    VALUES(${TENANT_ID}::uuid,${USER_ID}::uuid,'publisher','active')
  `;
  await database`
    INSERT INTO workspaces(id,tenant_id,name,slug,timezone,status)
    VALUES(
      ${WORKSPACE_ID}::uuid,${TENANT_ID}::uuid,'Browser Daily','browser-daily-154',
      'Asia/Shanghai','active'
    )
  `;
  await database`
    INSERT INTO workspace_memberships(workspace_id,user_id,scope_json)
    VALUES(${WORKSPACE_ID}::uuid,${USER_ID}::uuid,'{}'::jsonb)
  `;
  await database`
    INSERT INTO projects(id,tenant_id,workspace_id,name,owner_id,status)
    VALUES(
      ${PROJECT_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,
      '多平台每日内容',${USER_ID}::uuid,'active'
    )
  `;
  await database`
    INSERT INTO brand_profiles(
      id,tenant_id,workspace_id,version,status,schema_version,
      profile_json,created_by,published_at
    ) VALUES(
      ${BRAND_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,1,'published',
      'brand-profile@1',
      ${database.json({
        audience: ['广州搬家用户'],
        banned: ['虚假价格和排名'],
        compliance: ['只使用可核验事实'],
        cta: '通过页面联系方式咨询',
        differentiators: ['规范核对服务条件'],
        positioning: '广州示例搬家有限公司提供广州本地搬家服务',
        tone: '专业、实用',
      })},
      ${USER_ID}::uuid,now()
    )
  `;
  await database`
    INSERT INTO keyword_sets(id,tenant_id,project_id,name)
    VALUES(${KEYWORD_SET_ID}::uuid,${TENANT_ID}::uuid,${PROJECT_ID}::uuid,'多平台关键词')
  `;
  const certificateEvidence = [
    '资料类型：企业证照',
    '证照名称：道路运输经营许可证',
    '持证主体：广州示例搬家有限公司',
    '证照编号：粤交运管许可示例号',
    '发证机关：广州市交通运输主管部门',
  ].join('\n');
  await database`
    INSERT INTO source_documents(
      id,tenant_id,workspace_id,project_id,title,source_type,mime_type,
      uri,content_hash,trust_level,status,metadata_json,created_by
    ) VALUES(
      ${CERTIFICATE_SOURCE_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,
      ${PROJECT_ID}::uuid,'道路运输经营许可证','image','image/jpeg',
      'memory://browser-daily-certificate',${sha256(certificateEvidence)},'normal','active',
      ${database.json({
        article_use_allowed: true,
        certificate_name: '道路运输经营许可证',
        certificate_number: '粤交运管许可示例号',
        holder_name: '广州示例搬家有限公司',
        issuing_authority: '广州市交通运输主管部门',
        public_display_confirmed: true,
        schema_version: 'source-certificate@1',
        verification_url: null,
      })},${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO source_chunks(
      id,tenant_id,source_document_id,chunk_no,text,text_hash,
      metadata_json,token_count,status
    ) VALUES(
      ${CERTIFICATE_CHUNK_ID}::uuid,${TENANT_ID}::uuid,${CERTIFICATE_SOURCE_ID}::uuid,0,
      ${certificateEvidence},${sha256(certificateEvidence)},
      ${database.json({
        char_end: certificateEvidence.length,
        char_start: 0,
        schema_version: 'chunk-metadata@1',
      })},36,'active'
    )
  `;
  await database`
    INSERT INTO keywords(
      id,tenant_id,keyword_set_id,term,intent,intents,priority,platform_scope
    ) VALUES(
      ${KEYWORD_ID}::uuid,${TENANT_ID}::uuid,${KEYWORD_SET_ID}::uuid,
      '广州搬家','commercial',ARRAY['commercial'],100,ARRAY['sohu','lieju']::varchar[]
    )
  `;
  await database`
    INSERT INTO source_documents(
      id,tenant_id,workspace_id,project_id,title,source_type,mime_type,
      uri,content_hash,trust_level,status,created_by
    ) VALUES(
      ${SOURCE_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
      '企业服务资料','txt','text/plain','memory://browser-daily-source',
      ${sha256(evidence)},'verified','active',${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO source_chunks(
      id,tenant_id,source_document_id,chunk_no,text,text_hash,
      metadata_json,token_count,status
    ) VALUES(
      ${CHUNK_ID}::uuid,${TENANT_ID}::uuid,${SOURCE_ID}::uuid,0,${evidence},
      ${sha256(evidence)},
      ${database.json({
        char_end: evidence.length,
        char_start: 0,
        schema_version: 'chunk-metadata@1',
      })},
      24,'active'
    )
  `;
  await database`
    INSERT INTO prompt_versions(
      id,skill_name,version,schema_version,system_prompt,task_template,
      content_hash,status,created_by,published_at
    ) VALUES(
      ${WRITER_PROMPT_ID}::uuid,'content-writer','9.0.0','content-writer-data@1',
      'Write platform content.','Use {{writer_input}}.',
      ${'a'.repeat(64)},'published',${USER_ID}::uuid,now()
    )
  `;
  await database`
    INSERT INTO platform_rule_versions(
      id,platform_code,version,rules_json,content_hash,status,created_by,published_at
    ) VALUES
      (
        ${SOHU_RULE_ID}::uuid,'sohu','1.0.0',
        ${database.json({ schema_version: 'platform-rules@1', title_max: 72 })},
        ${'b'.repeat(64)},'published',${USER_ID}::uuid,now()
      ),
      (
        ${LIEJU_RULE_ID}::uuid,'lieju','1.0.0',
        ${database.json({ schema_version: 'platform-rules@1', title_max: 30 })},
        ${'c'.repeat(64)},'published',${USER_ID}::uuid,now()
      )
  `;
  await database`
    INSERT INTO platform_accounts(
      id,tenant_id,workspace_id,platform_code,provider_account_id,display_name,
      capabilities_json,publish_mode,status,timezone
    ) VALUES
      (
        ${SOHU_ACCOUNT_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,'sohu',
        'sohu-daily-154','搜狐号测试',${database.json({ publish: true })},
        'api','active','Asia/Shanghai'
      ),
      (
        ${LIEJU_ACCOUNT_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,'lieju',
        'lieju-daily-154','列举网测试',${database.json({ publish: true })},
        'api','active','Asia/Shanghai'
      )
  `;
  await database`
    INSERT INTO browser_platform_automation_policies(
      id,tenant_id,workspace_id,project_id,account_id,platform_code,
      enabled,daily_enabled,daily_target_count,daily_candidate_limit,
      daily_generation_time,daily_schedule_times,created_by
    ) VALUES
      (
        ${SOHU_POLICY_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
        ${SOHU_ACCOUNT_ID}::uuid,'sohu',true,true,1,1,TIME '00:00',
        ARRAY[TIME '10:00'],${USER_ID}::uuid
      ),
      (
        ${LIEJU_POLICY_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
        ${LIEJU_ACCOUNT_ID}::uuid,'lieju',true,true,1,1,TIME '00:00',
        ARRAY[TIME '10:00'],${USER_ID}::uuid
      )
  `;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireClient(value: Sql | undefined): Sql {
  if (!value) throw new Error('Browser daily scheduler PostgreSQL client was not initialized');
  return value;
}
