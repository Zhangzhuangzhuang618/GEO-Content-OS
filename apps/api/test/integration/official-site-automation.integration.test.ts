import type { QualityCheckerData, QualityGeoScores } from '@geo-content-os/contracts/skills';
import {
  contentHash,
  OfficialSiteAutomation,
  QualityCheckWorker,
  type GeneratedContent,
  validateQualityEvent,
} from '@geo-content-os/worker-ai';
import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import { ContentApiService } from '../../src/modules/content/api/content-api.service.js';
import type { IdentityAuthDatabase } from '../../src/modules/identity/auth/auth.database.js';
import { OutboxWriter } from '../../src/modules/outbox/index.js';

const USER_ID = '11000000-0000-4000-8000-000000000126';
const TENANT_ID = '21000000-0000-4000-8000-000000000126';
const WORKSPACE_ID = '31000000-0000-4000-8000-000000000126';
const PROJECT_ID = '41000000-0000-4000-8000-000000000126';
const BRIEF_ID = '51000000-0000-4000-8000-000000000126';
const PACKAGE_ID = '61000000-0000-4000-8000-000000000126';
const VARIANT_ID = '71000000-0000-4000-8000-000000000126';
const VERSION_ID = '81000000-0000-4000-8000-000000000126';
const MANUAL_VERSION_ID = '81100000-0000-4000-8000-000000000126';
const MASTER_VERSION_ID = '82000000-0000-4000-8000-000000000126';
const ACCOUNT_ID = '91000000-0000-4000-8000-000000000126';
const POLICY_ID = 'a1000000-0000-4000-8000-000000000126';
const BRAND_PROFILE_ID = 'a1100000-0000-4000-8000-000000000126';
const RULE_ID = 'a1200000-0000-4000-8000-000000000126';
const AUTOMATION_RUN_ID = 'a2000000-0000-4000-8000-000000000126';
const QUALITY_RUN_ID = 'a3000000-0000-4000-8000-000000000126';
const QUALITY_REPORT_ID = 'a4000000-0000-4000-8000-000000000126';
const SOURCE_EVENT_ID = 'a5000000-0000-4000-8000-000000000126';
const DAILY_BATCH_ID = 'a7000000-0000-4000-8000-000000000126';
const DAILY_ITEM_ID = 'a8000000-0000-4000-8000-000000000126';
const WRITER_PROMPT_ID = '25000000-0000-4000-8000-000000000008';
const QUALITY_PROMPT_ID = '25000000-0000-4000-8000-000000000007';

const INITIAL = content('Initial website article');
const REWRITTEN = content('Rewritten website article');
const SCORES: QualityGeoScores = Object.freeze({
  answerability: 92,
  entity: 94,
  evidence: 95,
  platform_fit: 90,
  question: 90,
  readability_safety: 90,
  total: 91,
});

describe('official-site quality, rewrite, and publication automation', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  let writer: FakeRewriteWriter;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 6 });
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`
      TRUNCATE
        official_site_automation_runs,official_site_automation_policies,quality_reports,
        publish_attempts,publish_jobs,platform_accounts,ai_citations,content_block_locks,
        content_blocks,content_versions,content_variants,content_packages,briefs,
        generation_runs,brand_profiles,workspace_memberships,projects,workspaces,
        audit_events,outbox_events,memberships,tenants,users
      CASCADE
    `;
    await seed(database);
    writer = new FakeRewriteWriter();
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('rewrites a failed article once, preserves the issue list, and queues a new quality check', async () => {
    const database = requireClient(client);
    const automation = createAutomation(database, writer);
    const event = await seedQualityCycle(database, 'quality_failed', 0);
    const policy = await automation.loadGatePolicy(database, TENANT_ID, VARIANT_ID);
    if (!policy) throw new Error('Automation policy was not loaded');
    const result = failedResult();
    const gate = automation.calculateGate(policy, result, result.geo_scores);

    await database.begin((transaction) =>
      automation.advanceAfterQuality(transaction, event, policy, QUALITY_REPORT_ID, gate, result),
    );
    const rewriteEvents = await database<{ payload: unknown }[]>`
      SELECT payload_json AS payload FROM outbox_events
      WHERE event_type='content.variant.official_site_rewrite_requested.v1'
      ORDER BY created_at DESC,id DESC
    `;
    expect(rewriteEvents).toHaveLength(1);
    const rewriteEvent = rewriteEvents[0]?.payload;
    await expect(automation.runRewrite(rewriteEvent)).resolves.toEqual({
      disposition: 'processed',
    });
    await expect(automation.runRewrite(rewriteEvent)).resolves.toEqual({
      disposition: 'completed',
    });

    expect(writer.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('gate.geo_total'),
        expect.stringContaining('facts.no_invented_price'),
      ]),
    );
    const states = await database<
      { contentVersionId: string; rewriteCount: number; status: string; variantStatus: string }[]
    >`
      SELECT automation.content_version_id AS "contentVersionId",
        automation.rewrite_count AS "rewriteCount",automation.status,
        variant.status AS "variantStatus"
      FROM official_site_automation_runs AS automation
      JOIN content_variants AS variant ON variant.id=automation.variant_id
      WHERE automation.id=${AUTOMATION_RUN_ID}::uuid
    `;
    expect(states[0]).toMatchObject({
      rewriteCount: 1,
      status: 'quality_pending',
      variantStatus: 'generated',
    });
    expect(states[0]?.contentVersionId).not.toBe(VERSION_ID);
    const queued = await database<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM outbox_events
      WHERE event_type='content.variant.quality_check_requested.v1'
    `;
    expect(queued).toEqual([{ count: 1 }]);
  });

  it('stops after three quality-gate rewrites and requires human handling', async () => {
    const database = requireClient(client);
    const automation = createAutomation(database, writer);
    const event = await seedQualityCycle(database, 'quality_failed', 3);
    const policy = await automation.loadGatePolicy(database, TENANT_ID, VARIANT_ID);
    if (!policy) throw new Error('Automation policy was not loaded');
    const result = failedResult();
    const gate = automation.calculateGate(policy, result, result.geo_scores);

    await database.begin((transaction) =>
      automation.advanceAfterQuality(transaction, event, policy, QUALITY_REPORT_ID, gate, result),
    );

    const state = await database<
      { code: string; finishedAt: Date | null; rewriteCount: number; status: string }[]
    >`
      SELECT status,rewrite_count AS "rewriteCount",finished_at AS "finishedAt",
        last_error_json->>'code' AS code
      FROM official_site_automation_runs WHERE id=${AUTOMATION_RUN_ID}::uuid
    `;
    expect(state[0]).toMatchObject({
      code: 'QUALITY_GATE_FAILED_AFTER_MAX_REWRITES',
      rewriteCount: 3,
      status: 'manual_required',
    });
    expect(state[0]?.finishedAt).toBeInstanceOf(Date);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM outbox_events
        WHERE event_type='content.variant.official_site_rewrite_requested.v1'
      `,
    ).toEqual([{ count: 0 }]);
  });

  it('schedules exactly one automatic website publication after every gate passes', async () => {
    const database = requireClient(client);
    const automation = createAutomation(database, writer);
    const event = await seedQualityCycle(database, 'quality_passed', 1);
    const policy = await automation.loadGatePolicy(database, TENANT_ID, VARIANT_ID);
    if (!policy) throw new Error('Automation policy was not loaded');
    const result: QualityCheckerData = {
      decision: 'pass',
      geo_scores: SCORES,
      issues: [],
      score: SCORES.total,
    };
    const gate = automation.calculateGate(policy, result, SCORES);
    expect(gate.passed).toBe(true);

    await database.begin((transaction) =>
      automation.advanceAfterQuality(transaction, event, policy, QUALITY_REPORT_ID, gate, result),
    );
    await database.begin((transaction) =>
      automation.advanceAfterQuality(transaction, event, policy, QUALITY_REPORT_ID, gate, result),
    );

    const jobs = await database<{ idempotencyKey: string; origin: string; status: string }[]>`
      SELECT idempotency_key AS "idempotencyKey",origin,status FROM publish_jobs
    `;
    expect(jobs).toEqual([
      {
        idempotencyKey: `official-site:${VARIANT_ID}:${VERSION_ID}`,
        origin: 'official_site_automation',
        status: 'scheduled',
      },
    ]);
    const state = await database<
      { automationStatus: string; publishJobId: string | null; variantStatus: string }[]
    >`
      SELECT automation.status AS "automationStatus",
        automation.publish_job_id AS "publishJobId",variant.status AS "variantStatus"
      FROM official_site_automation_runs AS automation
      JOIN content_variants AS variant ON variant.id=automation.variant_id
      WHERE automation.id=${AUTOMATION_RUN_ID}::uuid
    `;
    expect(state[0]).toMatchObject({
      automationStatus: 'publishing',
      publishJobId: expect.any(String),
      variantStatus: 'scheduled',
    });
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM outbox_events
        WHERE event_type='publishing.job.execution_requested.v1'
      `,
    ).toEqual([{ count: 1 }]);
  });

  it('holds a qualified daily article for the ten-article scheduler instead of publishing immediately', async () => {
    const database = requireClient(client);
    const automation = createAutomation(database, writer);
    const event = await seedQualityCycle(database, 'quality_passed', 0);
    await seedDailyItem(database);
    const policy = await automation.loadGatePolicy(database, TENANT_ID, VARIANT_ID);
    if (!policy) throw new Error('Automation policy was not loaded');
    const result: QualityCheckerData = {
      decision: 'pass',
      geo_scores: SCORES,
      issues: [],
      score: SCORES.total,
    };

    await database.begin((transaction) =>
      automation.advanceAfterQuality(
        transaction,
        event,
        policy,
        QUALITY_REPORT_ID,
        automation.calculateGate(policy, result, SCORES),
        result,
      ),
    );

    expect(
      await database<{ automationStatus: string; itemStatus: string; qualifiedAt: Date | null }[]>`
        SELECT automation.status AS "automationStatus",item.status AS "itemStatus",
          item.qualified_at AS "qualifiedAt"
        FROM official_site_daily_batch_items AS item
        JOIN official_site_automation_runs AS automation
          ON automation.variant_id=item.variant_id AND automation.tenant_id=item.tenant_id
        WHERE item.id=${DAILY_ITEM_ID}::uuid
      `,
    ).toEqual([
      {
        automationStatus: 'publish_pending',
        itemStatus: 'qualified',
        qualifiedAt: expect.any(Date),
      },
    ]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM publish_jobs
      `,
    ).toEqual([{ count: 0 }]);
  });

  it('retires a daily candidate after three failed rewrites so a replacement can be generated', async () => {
    const database = requireClient(client);
    const automation = createAutomation(database, writer);
    const event = await seedQualityCycle(database, 'quality_failed', 3);
    await seedDailyItem(database);
    const policy = await automation.loadGatePolicy(database, TENANT_ID, VARIANT_ID);
    if (!policy) throw new Error('Automation policy was not loaded');
    const result = failedResult();

    await database.begin((transaction) =>
      automation.advanceAfterQuality(
        transaction,
        event,
        policy,
        QUALITY_REPORT_ID,
        automation.calculateGate(policy, result, result.geo_scores),
        result,
      ),
    );

    expect(
      await database<{ code: string; status: string }[]>`
        SELECT status,last_error_json->>'code' AS code
        FROM official_site_daily_batch_items WHERE id=${DAILY_ITEM_ID}::uuid
      `,
    ).toEqual([{ code: 'QUALITY_GATE_FAILED_AFTER_MAX_REWRITES', status: 'retired' }]);
  });

  it('discards an obsolete quality result after a rewrite without failing the queue job', async () => {
    const database = requireClient(client);
    await seedQualityCycle(database, 'quality_failed', 0, 'queued');
    const edited = content('Concurrent rewrite replaced the checked content');
    let replaced = false;
    const checker = {
      evaluate: async () => {
        if (!replaced) {
          replaced = true;
          await database`
            INSERT INTO content_versions(
              id,tenant_id,package_id,variant_id,version_no,schema_version,
              content_json,content_hash,created_by
            ) VALUES(
              ${MANUAL_VERSION_ID}::uuid,${TENANT_ID}::uuid,${PACKAGE_ID}::uuid,
              ${VARIANT_ID}::uuid,2,${edited.schema_version},${database.json(edited)},
              ${contentHash(edited)},${USER_ID}::uuid
            )
          `;
          await database`
            UPDATE content_variants SET
              current_content_version_id=${MANUAL_VERSION_ID}::uuid,
              status='generated',version=version+1
            WHERE id=${VARIANT_ID}::uuid
          `;
        }
        return {
          decision: 'pass' as const,
          geo_scores: SCORES,
          issues: [],
          score: SCORES.total,
        };
      },
    };
    const worker = new QualityCheckWorker(database, checker as never);

    await expect(worker.run(qualityEvent())).resolves.toEqual({ disposition: 'completed' });

    expect(
      await database<
        {
          code: string;
          currentContentVersionId: string;
          runStatus: string;
          variantStatus: string;
        }[]
      >`
        SELECT
          run.status AS "runStatus",run.error_json->>'code' AS code,
          variant.current_content_version_id AS "currentContentVersionId",
          variant.status AS "variantStatus"
        FROM generation_runs AS run
        JOIN content_variants AS variant
          ON variant.id=run.variant_id AND variant.tenant_id=run.tenant_id
        WHERE run.id=${QUALITY_RUN_ID}::uuid
      `,
    ).toEqual([
      {
        code: 'QUALITY_RESULT_STALE',
        currentContentVersionId: MANUAL_VERSION_ID,
        runStatus: 'cancelled',
        variantStatus: 'generated',
      },
    ]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM quality_reports
        WHERE generation_run_id=${QUALITY_RUN_ID}::uuid
      `,
    ).toEqual([{ count: 0 }]);
  });

  it('resumes a manual-required automation run from the user-edited content version', async () => {
    const database = requireClient(client);
    const edited = content('User edited website article ready for another quality check');
    await database`
      INSERT INTO content_versions(
        id,tenant_id,package_id,variant_id,version_no,schema_version,
        content_json,content_hash,created_by
      ) VALUES(
        ${MANUAL_VERSION_ID}::uuid,${TENANT_ID}::uuid,${PACKAGE_ID}::uuid,
        ${VARIANT_ID}::uuid,2,${edited.schema_version},${database.json(edited)},
        ${contentHash(edited)},${USER_ID}::uuid
      )
    `;
    await database`
      UPDATE content_variants SET current_content_version_id=${MANUAL_VERSION_ID}::uuid,
        status='quality_failed' WHERE id=${VARIANT_ID}::uuid
    `;
    await database`
      INSERT INTO official_site_automation_runs(
        id,tenant_id,policy_id,variant_id,content_version_id,status,rewrite_count,finished_at
      ) VALUES(
        ${AUTOMATION_RUN_ID}::uuid,${TENANT_ID}::uuid,${POLICY_ID}::uuid,
        ${VARIANT_ID}::uuid,${VERSION_ID}::uuid,'manual_required',3,now()
      )
    `;
    const service = new ContentApiService(
      { client: database } as IdentityAuthDatabase,
      new OutboxWriter(database as never),
    );
    const previousEnvironment = {
      model: process.env['QUALITY_CHECKER_MODEL_KEY'],
      prompt: process.env['QUALITY_CHECKER_PROMPT_VERSION_ID'],
      version: process.env['QUALITY_CHECKER_SKILL_VERSION'],
    };
    process.env['QUALITY_CHECKER_MODEL_KEY'] = 'deepseek-v4-pro';
    process.env['QUALITY_CHECKER_PROMPT_VERSION_ID'] = QUALITY_PROMPT_ID;
    process.env['QUALITY_CHECKER_SKILL_VERSION'] = '1.0.0';
    try {
      await database.begin((transaction) =>
        service.requestQualityCheck(
          transaction,
          TENANT_ID,
          USER_ID,
          VARIANT_ID,
          contentHash(edited),
          { requestId: 'manual-recovery-126' },
        ),
      );
    } finally {
      restoreEnvironment('QUALITY_CHECKER_MODEL_KEY', previousEnvironment.model);
      restoreEnvironment('QUALITY_CHECKER_PROMPT_VERSION_ID', previousEnvironment.prompt);
      restoreEnvironment('QUALITY_CHECKER_SKILL_VERSION', previousEnvironment.version);
    }

    expect(
      await database<{ contentVersionId: string; rewriteCount: number; status: string }[]>`
        SELECT content_version_id AS "contentVersionId",rewrite_count AS "rewriteCount",status
        FROM official_site_automation_runs WHERE id=${AUTOMATION_RUN_ID}::uuid
      `,
    ).toEqual([
      { contentVersionId: MANUAL_VERSION_ID, rewriteCount: 0, status: 'quality_pending' },
    ]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM outbox_events
        WHERE event_type='content.variant.quality_check_requested.v1'
          AND payload_json->'data'->>'content_version_id'=${MANUAL_VERSION_ID}
      `,
    ).toEqual([{ count: 1 }]);
  });
});

class FakeRewriteWriter {
  public issues: readonly string[] = [];

  public async rewriteOfficialSiteVariant(input: {
    readonly issues: readonly string[];
  }): Promise<GeneratedContent> {
    this.issues = input.issues;
    return REWRITTEN;
  }
}

function createAutomation(database: Sql, writer: FakeRewriteWriter): OfficialSiteAutomation {
  return new OfficialSiteAutomation(database, writer as never, {
    qualityModelKey: 'deepseek-v4-pro',
    qualityPromptVersionId: QUALITY_PROMPT_ID,
    qualitySkillVersion: '1.0.0',
    rewriteModelKey: 'deepseek-v4-pro',
    writerPromptVersionId: WRITER_PROMPT_ID,
    writerSkillVersion: '1.0.0',
  });
}

async function seedQualityCycle(
  database: Sql,
  variantStatus: 'quality_failed' | 'quality_passed',
  rewriteCount: number,
  runStatus: 'queued' | 'succeeded' = 'succeeded',
) {
  await database`
    UPDATE content_variants SET status=${variantStatus} WHERE id=${VARIANT_ID}::uuid
  `;
  await database`
    INSERT INTO generation_runs(
      id,tenant_id,workspace_id,project_id,package_id,variant_id,skill_name,
      skill_version,prompt_version_id,model_key,status,input_hash,request_id
    ) VALUES(
      ${QUALITY_RUN_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,
      ${PROJECT_ID}::uuid,${PACKAGE_ID}::uuid,${VARIANT_ID}::uuid,'quality-checker',
      '1.0.0',${QUALITY_PROMPT_ID}::uuid,'deepseek-v4-pro',${runStatus},
      ${contentHash(INITIAL)},'auto-quality-126'
    )
  `;
  if (runStatus === 'succeeded') {
    await database`
      INSERT INTO quality_reports(
        id,tenant_id,variant_id,content_version_id,generation_run_id,checker_version,
        score,decision,issues_json,geo_scores_json
      ) VALUES(
        ${QUALITY_REPORT_ID}::uuid,${TENANT_ID}::uuid,${VARIANT_ID}::uuid,
        ${VERSION_ID}::uuid,${QUALITY_RUN_ID}::uuid,'1.0.0',84,'block',
        ${JSON.stringify({ issues: failedResult().issues, schema_version: 'quality-checker-data@1' })}::text::jsonb,
        ${database.json({ ...SCORES, schema_version: 'geo-scores@1' })}
      )
    `;
  }
  await database`
    INSERT INTO official_site_automation_runs(
      id,tenant_id,policy_id,variant_id,content_version_id,status,rewrite_count
    ) VALUES(
      ${AUTOMATION_RUN_ID}::uuid,${TENANT_ID}::uuid,${POLICY_ID}::uuid,
      ${VARIANT_ID}::uuid,${VERSION_ID}::uuid,'quality_pending',${rewriteCount}
    )
  `;
  return validateQualityEvent(qualityEvent());
}

function qualityEvent() {
  return {
    aggregate: { id: VARIANT_ID, type: 'content_variant' },
    data: {
      actor_user_id: USER_ID,
      content_hash: contentHash(INITIAL),
      content_version_id: VERSION_ID,
      generation_run_id: QUALITY_RUN_ID,
      package_id: PACKAGE_ID,
      project_id: PROJECT_ID,
      request_id: 'auto-quality-126',
      variant_id: VARIANT_ID,
      workspace_id: WORKSPACE_ID,
    },
    event_id: 'a6000000-0000-4000-8000-000000000126',
    event_type: 'content.variant.quality_check_requested.v1',
    occurred_at: '2026-07-23T00:00:00.000Z',
    tenant: { id: TENANT_ID },
  } as const;
}

async function seedDailyItem(database: Sql): Promise<void> {
  await database`
    UPDATE official_site_automation_policies SET daily_enabled=true
    WHERE id=${POLICY_ID}::uuid
  `;
  await database`
    INSERT INTO official_site_daily_batches(id,tenant_id,policy_id,business_date,status)
    VALUES(
      ${DAILY_BATCH_ID}::uuid,${TENANT_ID}::uuid,${POLICY_ID}::uuid,
      DATE '2026-07-23','running'
    )
  `;
  await database`
    INSERT INTO official_site_daily_batch_items(
      id,tenant_id,batch_id,candidate_no,angle_key,title,
      brief_id,package_id,variant_id,content_version_id,status
    ) VALUES(
      ${DAILY_ITEM_ID}::uuid,${TENANT_ID}::uuid,${DAILY_BATCH_ID}::uuid,1,
      'selection-guide','Website automation',
      ${BRIEF_ID}::uuid,${PACKAGE_ID}::uuid,${VARIANT_ID}::uuid,
      ${VERSION_ID}::uuid,'quality_check'
    )
  `;
}

function failedResult(): QualityCheckerData {
  return {
    decision: 'block',
    geo_scores: { ...SCORES, total: 84 },
    issues: [
      {
        category: 'fact',
        citation_ids: [],
        location: '正文',
        message: '价格没有输入依据',
        rule_id: 'facts.no_invented_price',
        severity: 'BLOCK',
        suggestion: '删除价格',
      },
    ],
    score: 84,
  };
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users(id,email,display_name,status)
    VALUES(${USER_ID}::uuid,'automation-126@example.com','Automation','active')
  `;
  await database`
    INSERT INTO tenants(id,name,slug,status)
    VALUES(${TENANT_ID}::uuid,'Automation Tenant','automation-126','active')
  `;
  await database`
    INSERT INTO memberships(tenant_id,user_id,role_code,status)
    VALUES(${TENANT_ID}::uuid,${USER_ID}::uuid,'publisher','active')
  `;
  await database`
    INSERT INTO workspaces(id,tenant_id,name,slug,timezone,status)
    VALUES(${WORKSPACE_ID}::uuid,${TENANT_ID}::uuid,'Automation','automation-126','Asia/Shanghai','active')
  `;
  await database`
    INSERT INTO workspace_memberships(workspace_id,user_id,scope_json)
    VALUES(${WORKSPACE_ID}::uuid,${USER_ID}::uuid,'{}'::jsonb)
  `;
  await database`
    INSERT INTO projects(id,tenant_id,workspace_id,name,owner_id,status)
    VALUES(${PROJECT_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,'Project',${USER_ID}::uuid,'active')
  `;
  await database`
    INSERT INTO brand_profiles(
      id,tenant_id,workspace_id,version,status,schema_version,
      profile_json,created_by,published_at
    ) VALUES(
      ${BRAND_PROFILE_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,1,'published',
      'brand-profile@1',
      ${database.json({
        audience: ['Website readers'],
        banned: ['Unverified prices and rankings'],
        compliance: ['Use verified facts'],
        cta: 'Contact the company for a verified service plan',
        differentiators: ['Traceable first-party evidence'],
        positioning: 'Evidence-led moving services',
        tone: 'Professional and direct',
      })},
      ${USER_ID}::uuid,now()
    )
  `;
  await database`
    INSERT INTO platform_rule_versions(
      id,platform_code,version,rules_json,content_hash,status,created_by,published_at
    ) VALUES(
      ${RULE_ID}::uuid,'official_site','1.0.0',
      ${database.json({
        accepted_first_party_source: 'published_brand_profile',
        require_citations: true,
        schema_version: 'platform-rules@1',
        title_max: 80,
      })},
      ${'b'.repeat(64)},'published',${USER_ID}::uuid,now()
    )
  `;
  await database`
    INSERT INTO briefs(
      id,tenant_id,workspace_id,project_id,title,objective,audience,
      platform_codes,constraints_json,created_by
    ) VALUES(
      ${BRIEF_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
      'Website automation','awareness','Website readers',ARRAY['official_site']::varchar[],
      ${database.json({ schema_version: 'brief-constraints@1' })},${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO content_packages(
      id,tenant_id,workspace_id,project_id,brief_id,status,created_by
    ) VALUES(
      ${PACKAGE_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
      ${BRIEF_ID}::uuid,'generated',${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO content_variants(
      id,tenant_id,package_id,platform_code,status,platform_account_id
    ) VALUES(
      ${VARIANT_ID}::uuid,${TENANT_ID}::uuid,${PACKAGE_ID}::uuid,'official_site','generated',
      NULL
    )
  `;
  await database`
    INSERT INTO content_versions(
      id,tenant_id,package_id,variant_id,version_no,schema_version,
      content_json,content_hash,created_by
    ) VALUES
      (${MASTER_VERSION_ID}::uuid,${TENANT_ID}::uuid,${PACKAGE_ID}::uuid,NULL,1,
       ${INITIAL.schema_version},${database.json({ ...INITIAL, platform_code: 'master' })},
       ${contentHash({ ...INITIAL, platform_code: 'master' })},${USER_ID}::uuid),
      (${VERSION_ID}::uuid,${TENANT_ID}::uuid,${PACKAGE_ID}::uuid,${VARIANT_ID}::uuid,1,
       ${INITIAL.schema_version},${database.json(INITIAL)},${contentHash(INITIAL)},${USER_ID}::uuid)
  `;
  await database`
    UPDATE content_packages SET master_content_version_id=${MASTER_VERSION_ID}::uuid
    WHERE id=${PACKAGE_ID}::uuid
  `;
  await database`
    UPDATE content_variants SET current_content_version_id=${VERSION_ID}::uuid
    WHERE id=${VARIANT_ID}::uuid
  `;
  await database`
    INSERT INTO platform_accounts(
      id,tenant_id,workspace_id,platform_code,provider_account_id,display_name,
      capabilities_json,publish_mode,status,timezone
    ) VALUES(
      ${ACCOUNT_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,'official_site',
      'zhiyuan-news','Zhiyuan Website',${database.json({ export: true, publish: true })},
      'api','active','Asia/Shanghai'
    )
  `;
  await database`
    UPDATE content_variants SET platform_account_id=${ACCOUNT_ID}::uuid
    WHERE id=${VARIANT_ID}::uuid
  `;
  await database`
    INSERT INTO official_site_automation_policies(
      id,tenant_id,workspace_id,project_id,account_id,enabled,created_by
    ) VALUES(
      ${POLICY_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
      ${ACCOUNT_ID}::uuid,true,${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO outbox_events(
      id,tenant_id,event_type,aggregate_type,aggregate_id,payload_json
    ) VALUES(
      ${SOURCE_EVENT_ID}::uuid,${TENANT_ID}::uuid,'content.package.generation_requested.v1',
      'content_package',${PACKAGE_ID}::uuid,${database.json({
        aggregate: { id: PACKAGE_ID, type: 'content_package' },
        data: {
          actor_user_id: USER_ID,
          variant_runs: [{ variant_id: VARIANT_ID }],
          writer_input: {
            brief: { id: BRIEF_ID, platform_codes: ['official_site'] },
            locked_blocks: [],
            platform_rules_by_code: { official_site: { platform_code: 'official_site' } },
          },
        },
        event_id: SOURCE_EVENT_ID,
        event_type: 'content.package.generation_requested.v1',
        occurred_at: '2026-07-23T00:00:00.000Z',
        tenant: { id: TENANT_ID },
      })}
    )
  `;
}

function content(title: string): GeneratedContent {
  return Object.freeze({
    blocks: Object.freeze([
      Object.freeze({ block_key: 'intro', block_type: 'heading', text: title }),
      Object.freeze({ block_key: 'body', block_type: 'paragraph', text: `${title} body` }),
    ]),
    citation_map: Object.freeze([]),
    cta: null,
    hashtags: Object.freeze([]),
    platform_code: 'official_site',
    platform_meta: Object.freeze({}),
    schema_version: 'content-writer-data@1',
    summary: `${title} summary`,
    title,
  });
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Automation PostgreSQL client was not initialized');
  return client;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
