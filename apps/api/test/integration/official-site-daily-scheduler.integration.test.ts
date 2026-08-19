import {
  OfficialSiteDailyScheduler,
  type GeneratedContent,
  contentHash,
} from '@geo-content-os/worker-ai';
import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import { createHash } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import { OfficialSiteAutomationPolicyService } from '../../src/modules/publishing/accounts/official-site-automation-policy.service.js';

const USER_ID = '11000000-0000-4000-8000-000000000139';
const TENANT_ID = '21000000-0000-4000-8000-000000000139';
const WORKSPACE_ID = '31000000-0000-4000-8000-000000000139';
const PROJECT_ID = '41000000-0000-4000-8000-000000000139';
const BRAND_ID = '51000000-0000-4000-8000-000000000139';
const KEYWORD_SET_ID = '61000000-0000-4000-8000-000000000139';
const KEYWORD_ID = '71000000-0000-4000-8000-000000000139';
const SOURCE_ID = '81000000-0000-4000-8000-000000000139';
const CHUNK_ID = '91000000-0000-4000-8000-000000000139';
const ACCOUNT_ID = 'a1000000-0000-4000-8000-000000000139';
const POLICY_ID = 'a2000000-0000-4000-8000-000000000139';
const RULE_ID = 'a3000000-0000-4000-8000-000000000139';
const WRITER_PROMPT_ID = '25000000-0000-4000-8000-000000000008';
const QUALITY_PROMPT_ID = '25000000-0000-4000-8000-000000000007';

describe('official-site daily ten-article scheduler', () => {
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

  it('recovers missing prerequisites, replaces a failed candidate, and schedules exactly ten qualified articles', async () => {
    const database = requireClient(client);
    const scheduler = createScheduler(database);

    await scheduler.tick();
    expect(await itemCounts(database)).toEqual({ generating: 0, retired: 0, total: 0 });
    expect(
      await database<{ status: string; errorCode: string | null }[]>`
        SELECT status,last_error_json->>'code' AS "errorCode"
        FROM official_site_daily_batches
        WHERE tenant_id=${TENANT_ID}::uuid AND policy_id=${POLICY_ID}::uuid
      `,
    ).toEqual([
      {
        errorCode: 'PUBLISHED_BRAND_PROFILE_REQUIRED',
        status: 'attention_required',
      },
    ]);

    await seedBrand(database);
    await scheduler.tick();
    const initial = await itemCounts(database);
    expect(initial).toEqual({ generating: 3, retired: 0, total: 3 });
    expect(await generationEventCount(database)).toBe(3);

    const failed = await database<{ variantId: string }[]>`
      SELECT variant_id AS "variantId"
      FROM official_site_daily_batch_items
      WHERE tenant_id=${TENANT_ID}::uuid
      ORDER BY candidate_no
      LIMIT 1
    `;
    await database`
      UPDATE content_variants SET status='generation_failed'
      WHERE id=${required(failed[0]?.variantId)}::uuid
    `;

    await scheduler.tick();
    expect(await itemCounts(database)).toEqual({ generating: 3, retired: 1, total: 4 });
    expect(await generationEventCount(database)).toBe(4);

    while (true) {
      const candidates = await database<
        { packageId: string; variantId: string; candidateNo: number }[]
      >`
        SELECT package_id AS "packageId",variant_id AS "variantId",
          candidate_no AS "candidateNo"
        FROM official_site_daily_batch_items
        WHERE tenant_id=${TENANT_ID}::uuid AND status='generating'
        ORDER BY candidate_no
      `;
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.length).toBeLessThanOrEqual(3);
      for (const candidate of candidates) {
        await qualify(database, candidate);
      }
      if ((await qualifiedCount(database)) >= 10) break;
      await scheduler.tick();
    }

    const batches = await database<{ businessDate: string }[]>`
      SELECT business_date::text AS "businessDate"
      FROM official_site_daily_batches
      WHERE tenant_id=${TENANT_ID}::uuid AND policy_id=${POLICY_ID}::uuid
    `;
    const businessDate = required(batches[0]?.businessDate);
    await scheduler.tick(new Date(`${businessDate}T00:00:00+08:00`));

    const jobs = await database<{ idempotencyKey: string; scheduledAt: Date; status: string }[]>`
      SELECT idempotency_key AS "idempotencyKey",scheduled_at AS "scheduledAt",status
      FROM publish_jobs
      WHERE tenant_id=${TENANT_ID}::uuid AND origin='official_site_automation'
      ORDER BY scheduled_at,id
    `;
    expect(jobs).toHaveLength(10);
    expect(new Set(jobs.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(10);
    expect(jobs.map(({ scheduledAt }) => scheduledAt.toISOString().slice(11, 16))).toEqual([
      '00:00',
      '01:30',
      '03:00',
      '04:30',
      '06:00',
      '07:30',
      '09:00',
      '10:30',
      '12:00',
      '13:30',
    ]);
    expect(new Set(jobs.map(({ status }) => status))).toEqual(new Set(['scheduled']));
    expect(
      await database<{ status: string }[]>`
        SELECT status FROM official_site_daily_batches
        WHERE tenant_id=${TENANT_ID}::uuid AND policy_id=${POLICY_ID}::uuid
      `,
    ).toEqual([{ status: 'scheduled' }]);
  });

  it('schedules partial successes and a restart only fills the remaining daily slot', async () => {
    const database = requireClient(client);
    const scheduler = createScheduler(database);

    await scheduler.tick();
    await seedBrand(database);
    await scheduler.tick();
    const batchRows = await database<{ businessDate: string }[]>`
      SELECT business_date::text AS "businessDate"
      FROM official_site_daily_batches
      WHERE tenant_id=${TENANT_ID}::uuid AND policy_id=${POLICY_ID}::uuid
    `;
    const businessDate = required(batchRows[0]?.businessDate);
    const planNow = new Date(`${businessDate}T00:00:00+08:00`);
    let passed = 0;

    for (let cycle = 0; cycle < 40; cycle += 1) {
      const candidates = await database<
        { candidateNo: number; packageId: string; variantId: string }[]
      >`
        SELECT candidate_no AS "candidateNo",package_id AS "packageId",
          variant_id AS "variantId"
        FROM official_site_daily_batch_items
        WHERE tenant_id=${TENANT_ID}::uuid AND status='generating'
        ORDER BY candidate_no
      `;
      for (const candidate of candidates) {
        if (passed < 9) {
          await qualify(database, candidate);
          passed += 1;
        } else {
          await database`
            UPDATE content_variants SET status='generation_failed'
            WHERE id=${candidate.variantId}::uuid AND tenant_id=${TENANT_ID}::uuid
          `;
        }
      }
      await scheduler.tick(planNow);
      const statuses = await database<{ status: string }[]>`
        SELECT status FROM official_site_daily_batches
        WHERE tenant_id=${TENANT_ID}::uuid AND policy_id=${POLICY_ID}::uuid
        ORDER BY attempt_no DESC LIMIT 1
      `;
      if (statuses[0]?.status === 'attention_required') break;
    }

    expect(await generationEventCount(database)).toBe(30);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM publish_jobs
        WHERE tenant_id=${TENANT_ID}::uuid AND origin='official_site_automation'
      `,
    ).toEqual([{ count: 9 }]);
    const exhausted = await database<
      { status: string; version: number; errorCode: string | null }[]
    >`
      SELECT status,version,last_error_json->>'code' AS "errorCode"
      FROM official_site_daily_batches
      WHERE tenant_id=${TENANT_ID}::uuid AND policy_id=${POLICY_ID}::uuid
      ORDER BY attempt_no DESC LIMIT 1
    `;
    expect(exhausted).toEqual([
      expect.objectContaining({
        errorCode: 'DAILY_CANDIDATE_LIMIT_REACHED',
        status: 'attention_required',
      }),
    ]);

    const policyService = new OfficialSiteAutomationPolicyService(database);
    const restarted = await database.begin((transaction) =>
      policyService.restartDailyBatchInTransaction(
        transaction,
        { tenantId: TENANT_ID, userId: USER_ID },
        ACCOUNT_ID,
        {
          expected_batch_version: required(exhausted[0]?.version),
          project_id: PROJECT_ID,
        },
        { requestId: 'daily-partial-restart-139' },
      ),
    );
    expect(restarted.today_batch).toMatchObject({
      attempt_no: 2,
      attempted_count: 0,
      qualified_count: 9,
      scheduled_count: 9,
      status: 'running',
    });

    await scheduler.tick(planNow);
    const replacements = await database<
      { angleKey: string; candidateNo: number; packageId: string; variantId: string }[]
    >`
      SELECT item.angle_key AS "angleKey",item.candidate_no AS "candidateNo",
        item.package_id AS "packageId",item.variant_id AS "variantId"
      FROM official_site_daily_batch_items AS item
      JOIN official_site_daily_batches AS batch ON batch.id=item.batch_id
      WHERE item.tenant_id=${TENANT_ID}::uuid AND batch.attempt_no=2
    `;
    expect(replacements).toHaveLength(1);
    expect(replacements[0]?.candidateNo).toBe(1);
    const scheduledAngles = await database<{ angleKey: string }[]>`
      SELECT angle_key AS "angleKey" FROM official_site_daily_batch_items
      WHERE tenant_id=${TENANT_ID}::uuid AND status='scheduled'
    `;
    expect(scheduledAngles.map((row) => row.angleKey)).not.toContain(replacements[0]?.angleKey);

    await qualify(database, required(replacements[0]));
    await scheduler.tick(planNow);
    const jobs = await database<{ idempotencyKey: string; scheduledAt: Date }[]>`
      SELECT idempotency_key AS "idempotencyKey",scheduled_at AS "scheduledAt"
      FROM publish_jobs
      WHERE tenant_id=${TENANT_ID}::uuid AND origin='official_site_automation'
      ORDER BY scheduled_at,id
    `;
    expect(jobs).toHaveLength(10);
    expect(new Set(jobs.map((job) => job.idempotencyKey)).size).toBe(10);
    expect(new Set(jobs.map((job) => job.scheduledAt.toISOString())).size).toBe(10);
    expect(
      await database<{ attemptNo: number; status: string }[]>`
        SELECT attempt_no AS "attemptNo",status FROM official_site_daily_batches
        WHERE tenant_id=${TENANT_ID}::uuid AND policy_id=${POLICY_ID}::uuid
        ORDER BY attempt_no
      `,
    ).toEqual([
      { attemptNo: 1, status: 'cancelled' },
      { attemptNo: 2, status: 'scheduled' },
    ]);
  });
});

function createScheduler(database: Sql) {
  return new OfficialSiteDailyScheduler(
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
      retrieve: () =>
        Promise.resolve({
          citations: [{ chunkId: CHUNK_ID, quoteText: '测试引用', sourceId: SOURCE_ID }],
          contextHash: 'a'.repeat(64),
          degraded: false,
          queryHash: 'b'.repeat(64),
        }),
    },
  );
}

async function qualify(
  database: Sql,
  candidate: { packageId: string; variantId: string; candidateNo: number },
): Promise<void> {
  const content = article(candidate.candidateNo);
  const versions = await database<{ id: string }[]>`
    INSERT INTO content_versions(
      tenant_id,package_id,variant_id,version_no,schema_version,
      content_json,content_hash,created_by
    ) VALUES(
      ${TENANT_ID}::uuid,${candidate.packageId}::uuid,${candidate.variantId}::uuid,
      1,${content.schema_version},${database.json(content)},${contentHash(content)},
      ${USER_ID}::uuid
    )
    RETURNING id
  `;
  const versionId = required(versions[0]?.id);
  await database`
    UPDATE content_variants SET
      current_content_version_id=${versionId}::uuid,status='quality_passed',version=version+1
    WHERE id=${candidate.variantId}::uuid AND tenant_id=${TENANT_ID}::uuid
  `;
  await database`
    UPDATE content_packages SET status='generated'
    WHERE id=${candidate.packageId}::uuid AND tenant_id=${TENANT_ID}::uuid
  `;
  await database`
    INSERT INTO official_site_automation_runs(
      tenant_id,policy_id,variant_id,content_version_id,status
    ) VALUES(
      ${TENANT_ID}::uuid,${POLICY_ID}::uuid,${candidate.variantId}::uuid,
      ${versionId}::uuid,'publish_pending'
    )
  `;
  await database`
    UPDATE official_site_daily_batch_items SET
      content_version_id=${versionId}::uuid,status='qualified',qualified_at=now()
    WHERE tenant_id=${TENANT_ID}::uuid AND variant_id=${candidate.variantId}::uuid
  `;
}

async function itemCounts(database: Sql) {
  const rows = await database<{ generating: number; retired: number; total: number }[]>`
    SELECT count(*)::integer AS total,
      count(*) FILTER (WHERE status='generating')::integer AS generating,
      count(*) FILTER (WHERE status='retired')::integer AS retired
    FROM official_site_daily_batch_items WHERE tenant_id=${TENANT_ID}::uuid
  `;
  return rows[0];
}

async function qualifiedCount(database: Sql): Promise<number> {
  const rows = await database<{ count: number }[]>`
    SELECT count(*)::integer AS count
    FROM official_site_daily_batch_items
    WHERE tenant_id=${TENANT_ID}::uuid AND status='qualified'
  `;
  return rows[0]?.count ?? 0;
}

async function generationEventCount(database: Sql): Promise<number> {
  const rows = await database<{ count: number }[]>`
    SELECT count(*)::integer AS count FROM outbox_events
    WHERE tenant_id=${TENANT_ID}::uuid
      AND event_type='content.package.generation_requested.v1'
  `;
  return rows[0]?.count ?? 0;
}

async function seed(database: Sql): Promise<void> {
  const evidence = '志远搬家自有大型车辆30余台，搬家师傅为购买社保的正式员工。';
  await database`
    INSERT INTO users(id,email,display_name,status)
    VALUES(${USER_ID}::uuid,'daily-139@example.com','Daily Publisher','active')
  `;
  await database`
    INSERT INTO tenants(id,name,slug,status)
    VALUES(${TENANT_ID}::uuid,'Daily Tenant','daily-139','active')
  `;
  await database`
    INSERT INTO memberships(tenant_id,user_id,role_code,status)
    VALUES(${TENANT_ID}::uuid,${USER_ID}::uuid,'publisher','active')
  `;
  await database`
    INSERT INTO workspaces(id,tenant_id,name,slug,timezone,status)
    VALUES(
      ${WORKSPACE_ID}::uuid,${TENANT_ID}::uuid,'Daily Website','daily-139',
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
      '志远官网每日内容',${USER_ID}::uuid,'active'
    )
  `;
  await database`
    INSERT INTO keyword_sets(id,tenant_id,project_id,name)
    VALUES(${KEYWORD_SET_ID}::uuid,${TENANT_ID}::uuid,${PROJECT_ID}::uuid,'官网关键词')
  `;
  await database`
    INSERT INTO keywords(
      id,tenant_id,keyword_set_id,term,intent,intents,priority,platform_scope
    ) VALUES(
      ${KEYWORD_ID}::uuid,${TENANT_ID}::uuid,${KEYWORD_SET_ID}::uuid,
      '广州搬家公司','commercial',ARRAY['commercial'],100,ARRAY['official_site']::varchar[]
    )
  `;
  await database`
    INSERT INTO source_documents(
      id,tenant_id,workspace_id,project_id,title,source_type,mime_type,
      uri,content_hash,trust_level,status,created_by
    ) VALUES(
      ${SOURCE_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
      '志远企业第一方资料','txt','text/plain','memory://zhiyuan-first-party',
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
      32,'active'
    )
  `;
  await database`
    INSERT INTO prompt_versions(
      id,skill_name,version,schema_version,system_prompt,task_template,
      content_hash,status,created_by,published_at
    ) VALUES(
      ${WRITER_PROMPT_ID}::uuid,'content-writer','9.0.0','content-writer-data@1',
      'Write verified official-site content.','Use {{writer_input}}.',
      ${'a'.repeat(64)},'published',${USER_ID}::uuid,now()
    )
  `;
  await database`
    INSERT INTO platform_rule_versions(
      id,platform_code,version,rules_json,content_hash,status,created_by,published_at
    ) VALUES(
      ${RULE_ID}::uuid,'official_site','9.0.0',
      ${database.json({
        require_citations: true,
        schema_version: 'platform-rules@1',
        title_max: 80,
      })},
      ${'b'.repeat(64)},'published',${USER_ID}::uuid,now()
    )
  `;
  await database`
    INSERT INTO platform_accounts(
      id,tenant_id,workspace_id,platform_code,provider_account_id,display_name,
      capabilities_json,publish_mode,status,timezone
    ) VALUES(
      ${ACCOUNT_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,'official_site',
      'zhiyuan-production','志远官网（测试）',
      ${database.json({ get_status: true, publish: true })},'api','active','Asia/Shanghai'
    )
  `;
  await database`
    INSERT INTO official_site_automation_policies(
      id,tenant_id,workspace_id,project_id,account_id,enabled,daily_enabled,created_by
    ) VALUES(
      ${POLICY_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
      ${ACCOUNT_ID}::uuid,true,true,${USER_ID}::uuid
    )
  `;
}

async function seedBrand(database: Sql): Promise<void> {
  await database`
    INSERT INTO brand_profiles(
      id,tenant_id,workspace_id,version,status,schema_version,
      profile_json,created_by,published_at
    ) VALUES(
      ${BRAND_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,1,'published',
      'brand-profile@1',
      ${database.json({
        audience: ['广州搬家用户'],
        banned: ['未经证实的价格和排名'],
        compliance: ['只使用可核验事实'],
        cta: '联系企业获取搬家方案',
        differentiators: ['自有大型车辆30余台', '正式员工搬家师傅'],
        positioning: '广州本地专业搬家服务',
        tone: '专业、直接、实用',
      })},
      ${USER_ID}::uuid,now()
    )
  `;
}

function article(candidateNo: number): GeneratedContent {
  return {
    blocks: [
      { block_key: 'intro', block_type: 'heading', text: `广州搬家指南 ${candidateNo}` },
      { block_key: 'body', block_type: 'paragraph', text: '依据企业资料整理的实用内容。' },
    ],
    citation_map: [],
    cta: null,
    hashtags: [],
    platform_code: 'official_site',
    platform_meta: {},
    schema_version: 'content-writer-data@1',
    summary: '广州搬家实用指南。',
    title: `广州搬家指南 ${candidateNo}`,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

function requireClient(value: Sql | undefined): Sql {
  if (!value) throw new Error('Daily scheduler PostgreSQL client was not initialized');
  return value;
}
