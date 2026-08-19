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

const USER_ID = '12000000-0000-4000-8000-000000000154';
const TENANT_ID = '22000000-0000-4000-8000-000000000154';
const WORKSPACE_ID = '32000000-0000-4000-8000-000000000154';
const PROJECT_ID = '42000000-0000-4000-8000-000000000154';
const BRAND_ID = '52000000-0000-4000-8000-000000000154';
const KEYWORD_SET_ID = '62000000-0000-4000-8000-000000000154';
const KEYWORD_ID = '72000000-0000-4000-8000-000000000154';
const SOURCE_ID = '82000000-0000-4000-8000-000000000154';
const CHUNK_ID = '92000000-0000-4000-8000-000000000154';
const SOHU_ACCOUNT_ID = 'a1000000-0000-4000-8000-000000000154';
const LIEJU_ACCOUNT_ID = 'a2000000-0000-4000-8000-000000000154';
const SOHU_POLICY_ID = 'a3000000-0000-4000-8000-000000000154';
const LIEJU_POLICY_ID = 'a4000000-0000-4000-8000-000000000154';
const SOHU_RULE_ID = 'a5000000-0000-4000-8000-000000000154';
const LIEJU_RULE_ID = 'a6000000-0000-4000-8000-000000000154';
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

  it('retrieves and freezes evidence independently for Sohu and Lieju candidates', async () => {
    const database = requireClient(client);
    const requests: DailyCitationRequest[] = [];
    const citations: DailyCitationPort = {
      retrieve: (input) => {
        requests.push(input);
        return Promise.resolve({
          citations: [{ chunkId: CHUNK_ID, quoteText: '企业可核验服务资料', sourceId: SOURCE_ID }],
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
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM brief_sources
        WHERE tenant_id=${TENANT_ID}::uuid AND source_document_id=${SOURCE_ID}::uuid
      `,
    ).toEqual([{ count: 2 }]);
    expect(
      await database<{ chunkId: string; platformCode: string; sourceId: string }[]>`
        SELECT
          event.payload_json->'data'->'variant_runs'->0->>'platform_code' AS "platformCode",
          event.payload_json->'data'->'writer_input'->'citations'->0->>'chunk_id' AS "chunkId",
          event.payload_json->'data'->'writer_input'->'citations'->0->>'source_id' AS "sourceId"
        FROM outbox_events AS event
        WHERE event.tenant_id=${TENANT_ID}::uuid
          AND event.event_type='content.package.generation_requested.v1'
        ORDER BY "platformCode"
      `,
    ).toEqual([
      { chunkId: CHUNK_ID, platformCode: 'lieju', sourceId: SOURCE_ID },
      { chunkId: CHUNK_ID, platformCode: 'sohu', sourceId: SOURCE_ID },
    ]);
  });
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
        positioning: '广州本地搬家服务',
        tone: '专业、实用',
      })},
      ${USER_ID}::uuid,now()
    )
  `;
  await database`
    INSERT INTO keyword_sets(id,tenant_id,project_id,name)
    VALUES(${KEYWORD_SET_ID}::uuid,${TENANT_ID}::uuid,${PROJECT_ID}::uuid,'多平台关键词')
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
