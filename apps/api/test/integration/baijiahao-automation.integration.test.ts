import { BaijiahaoAutomationPolicyViewSchema } from '@geo-content-os/contracts';
import {
  BaijiahaoAutomation,
  BaijiahaoDailyScheduler,
  contentHash,
  type GeneratedContent,
  type ValidatedGenerationEvent,
} from '@geo-content-os/worker-ai';
import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import { createHash } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import { ContentApiService } from '../../src/modules/content/api/content-api.service.js';
import type { IdentityAuthDatabase } from '../../src/modules/identity/auth/auth.database.js';
import { OutboxWriter } from '../../src/modules/outbox/index.js';
import { BaijiahaoAutomationPolicyService } from '../../src/modules/publishing/accounts/index.js';

const USER_ID = '11000000-0000-4000-8000-000000000145';
const TENANT_ID = '21000000-0000-4000-8000-000000000145';
const WORKSPACE_ID = '31000000-0000-4000-8000-000000000145';
const PROJECT_ID = '41000000-0000-4000-8000-000000000145';
const BRIEF_ID = '51000000-0000-4000-8000-000000000145';
const PACKAGE_ID = '61000000-0000-4000-8000-000000000145';
const OFFICIAL_VARIANT_ID = '71000000-0000-4000-8000-000000000145';
const CONTENT_VERSION_ID = '81000000-0000-4000-8000-000000000145';
const OFFICIAL_ACCOUNT_ID = '91000000-0000-4000-8000-000000000145';
const BAIJIAHAO_ACCOUNT_ID = '92000000-0000-4000-8000-000000000145';
const PUBLISH_JOB_ID = 'a1000000-0000-4000-8000-000000000145';
const POLICY_ID = 'a2000000-0000-4000-8000-000000000145';
const DAILY_BATCH_ID = 'a2100000-0000-4000-8000-000000000145';
const INDEPENDENT_BATCH_ID = 'a2200000-0000-4000-8000-000000000145';
const INDEPENDENT_RUN_ID = 'a2300000-0000-4000-8000-000000000145';
const INDEPENDENT_ITEM_ID = 'a2400000-0000-4000-8000-000000000145';
const INDEPENDENT_VARIANT_ID = 'a2500000-0000-4000-8000-000000000145';
const INDEPENDENT_VERSION_ID = 'a2600000-0000-4000-8000-000000000145';
const OTHER_BRIEF_ID = 'a2700000-0000-4000-8000-000000000145';
const OTHER_PACKAGE_ID = 'a2800000-0000-4000-8000-000000000145';
const OTHER_VARIANT_ID = 'a2900000-0000-4000-8000-000000000145';
const OTHER_RUN_ID = 'a2a00000-0000-4000-8000-000000000145';
const DERIVED_REGENERATION_VERSION_ID = 'a2b00000-0000-4000-8000-000000000145';
const MANUAL_QUALITY_RUN_ID = 'a2c00000-0000-4000-8000-000000000145';
const MANUAL_QUALITY_REPORT_ID = 'a2d00000-0000-4000-8000-000000000145';
const BRAND_PROFILE_ID = 'a3000000-0000-4000-8000-000000000145';
const RULE_ID = 'a4000000-0000-4000-8000-000000000145';
const SOURCE_ID = 'a5000000-0000-4000-8000-000000000145';
const CHUNK_ID = 'a6000000-0000-4000-8000-000000000145';
const CITATION_ID = 'a7000000-0000-4000-8000-000000000145';
const WRITER_PROMPT_ID = '25000000-0000-4000-8000-000000000008';
const QUALITY_PROMPT_ID = '25000000-0000-4000-8000-000000000007';
const OFFICIAL_URL = 'https://www.zhiyuanbj.cn/news/t145-source.html';

const ARTICLE = article();
const SHORT_ARTICLE: GeneratedContent = Object.freeze({
  ...ARTICLE,
  blocks: Object.freeze([
    Object.freeze({ block_key: 'intro', block_type: 'heading', text: '搬家前检查清单' }),
    Object.freeze({ block_key: 'body', block_type: 'paragraph', text: '先核对物品和通道。' }),
  ]),
  summary: '简短清单',
  title: '搬家前检查清单',
});

describe('Baijiahao official-site derived automation', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 4 });
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await reset(database);
    await seed(database, ARTICLE);
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('creates one traceable adaptation only after the official-site job is published', async () => {
    const database = requireClient(client);
    const automation = createAutomation(database);

    await expect(automation.handlePublishedSource(publishedEvent())).resolves.toEqual({
      disposition: 'processed',
    });
    await expect(automation.handlePublishedSource(publishedEvent())).resolves.toEqual({
      disposition: 'completed',
    });

    const runs = await database<
      {
        citationIds: string[];
        sourceContentVersionId: string;
        sourceMode: string;
        sourcePublishJobId: string;
        sourceUrl: string;
        status: string;
      }[]
    >`
      SELECT source_mode AS "sourceMode",source_content_version_id AS "sourceContentVersionId",
        source_publish_job_id AS "sourcePublishJobId",source_url AS "sourceUrl",status,
        source_provenance_json->'citation_ids' AS "citationIds"
      FROM baijiahao_automation_runs
    `;
    expect(runs).toEqual([
      {
        citationIds: [CITATION_ID],
        sourceContentVersionId: CONTENT_VERSION_ID,
        sourceMode: 'official_site_derived',
        sourcePublishJobId: PUBLISH_JOB_ID,
        sourceUrl: OFFICIAL_URL,
        status: 'adaptation_pending',
      },
    ]);
    expect(
      await database<
        { accountId: string; platformCode: string; required: boolean; status: string }[]
      >`
        SELECT platform_account_id AS "accountId",platform_code AS "platformCode",
          is_required AS required,status
        FROM content_variants WHERE platform_code='baijiahao'
      `,
    ).toEqual([
      {
        accountId: BAIJIAHAO_ACCOUNT_ID,
        platformCode: 'baijiahao',
        required: false,
        status: 'generating',
      },
    ]);
    const events = await database<{ count: number; sourceVersionId: string }[]>`
      SELECT count(*)::integer AS count,
        min(payload_json->'data'->>'source_content_version_id') AS "sourceVersionId"
      FROM outbox_events
      WHERE event_type='content.variant.baijiahao_adaptation_requested.v1'
    `;
    expect(events).toEqual([{ count: 1, sourceVersionId: CONTENT_VERSION_ID }]);
    expect(
      await database<{ sources: number; status: string }[]>`
        SELECT
          (SELECT count(*)::integer FROM source_documents) AS sources,
          item.status
        FROM baijiahao_daily_batch_items AS item
      `,
    ).toEqual([{ sources: 1, status: 'adapting' }]);
  });

  it('ignores forged publication events when the source job is not published', async () => {
    const database = requireClient(client);
    await database`
      UPDATE publish_jobs SET status='scheduled',published_at=NULL,
        external_post_id=NULL,external_url=NULL
      WHERE id=${PUBLISH_JOB_ID}::uuid
    `;

    await expect(
      createAutomation(database).handlePublishedSource(publishedEvent()),
    ).resolves.toEqual({ disposition: 'completed' });
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM baijiahao_automation_runs
      `,
    ).toEqual([{ count: 0 }]);
  });

  it('records an unsuitable source as skipped without creating a Baijiahao variant', async () => {
    const database = requireClient(client);
    await reset(database);
    await seed(database, SHORT_ARTICLE);

    await expect(
      createAutomation(database).handlePublishedSource(publishedEvent()),
    ).resolves.toEqual({ disposition: 'processed' });
    expect(
      await database<{ reason: string; status: string }[]>`
        SELECT status,source_provenance_json->>'reason' AS reason
        FROM baijiahao_automation_runs
      `,
    ).toEqual([{ reason: 'source_too_short', status: 'skipped' }]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM content_variants
        WHERE platform_code='baijiahao'
      `,
    ).toEqual([{ count: 0 }]);
  });

  it('does not count an unfinished run as a completed daily target', async () => {
    const database = requireClient(client);
    await seedOtherInProgressAutomation(database);

    await expect(
      createAutomation(database).handlePublishedSource(publishedEvent()),
    ).resolves.toEqual({ disposition: 'processed' });

    expect(
      await database<{ count: number; status: string }[]>`
        SELECT status,count(*)::integer AS count
        FROM baijiahao_automation_runs GROUP BY status ORDER BY status
      `,
    ).toEqual([
      { count: 1, status: 'adaptation_pending' },
      { count: 1, status: 'generation_pending' },
    ]);
  });

  it('expires a past running batch when both the batch and policy have version columns', async () => {
    const database = requireClient(client);
    await database`
      UPDATE baijiahao_automation_policies SET version=9 WHERE id=${POLICY_ID}::uuid
    `;
    await database`
      INSERT INTO baijiahao_daily_batches(
        id,tenant_id,policy_id,business_date,status,version
      ) VALUES(
        ${DAILY_BATCH_ID}::uuid,${TENANT_ID}::uuid,${POLICY_ID}::uuid,
        (now() AT TIME ZONE 'Asia/Shanghai')::date - 1,'running',4
      )
    `;
    const scheduler = new BaijiahaoDailyScheduler(
      database,
      {
        qualityModelKey: 'deepseek-v4-flash',
        qualityPromptVersionId: QUALITY_PROMPT_ID,
        qualitySkillVersion: '1.0.0',
        rewriteModelKey: 'deepseek-v4-flash',
        writerPromptVersionId: WRITER_PROMPT_ID,
        writerSkillVersion: '1.0.0',
      },
      { tickMs: 30_000 },
    );

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(
      await database<{ code: string; policyVersion: number; status: string; version: number }[]>`
        SELECT batch.status,batch.version,policy.version AS "policyVersion",
          batch.last_error_json->>'code' AS code
        FROM baijiahao_daily_batches AS batch
        JOIN baijiahao_automation_policies AS policy
          ON policy.id=batch.policy_id AND policy.tenant_id=batch.tenant_id
        WHERE batch.id=${DAILY_BATCH_ID}::uuid
      `,
    ).toEqual([
      {
        code: 'DAILY_BATCH_DAY_ENDED',
        policyVersion: 9,
        status: 'attention_required',
        version: 5,
      },
    ]);
  });

  it('queues quality for an independent fallback run owned by a derived-source policy', async () => {
    const database = requireClient(client);
    const generatedHash = await seedGeneratedIndependentCandidate(database);
    const automation = createAutomation(database);

    await database.begin((transaction) =>
      automation.queueQualityAfterGeneration(
        transaction,
        independentGenerationEvent(),
        INDEPENDENT_VARIANT_ID,
        INDEPENDENT_VERSION_ID,
        generatedHash,
        independentArticle(),
      ),
    );

    await expectIndependentQualityQueued(database);
    const policy = (
      await new BaijiahaoAutomationPolicyService(database, {} as never).list(
        { tenantId: TENANT_ID, userId: USER_ID },
        BAIJIAHAO_ACCOUNT_ID,
      )
    )[0];
    expect(() => BaijiahaoAutomationPolicyViewSchema.parse(policy)).not.toThrow();
    expect(policy?.today_batch).toMatchObject({
      active_items: [
        {
          automation_run_id: INDEPENDENT_RUN_ID,
          candidate_no: 1,
          item_status: 'quality_check',
          run_status: 'quality_pending',
        },
      ],
      in_progress_count: 1,
      retired_count: 0,
    });
  });

  it('recovers an already generated independent fallback exactly once', async () => {
    const database = requireClient(client);
    await seedGeneratedIndependentCandidate(database);
    const automation = createAutomation(database);

    await expect(automation.recoverGeneratedIndependentCandidates()).resolves.toBe(1);
    await expect(automation.recoverGeneratedIndependentCandidates()).resolves.toBe(0);

    await expectIndependentQualityQueued(database);
  });

  it('reattaches a regenerated derived candidate and recalculates source similarity', async () => {
    const database = requireClient(client);
    const automation = createAutomation(database);
    await automation.handlePublishedSource(publishedEvent());
    const runs = await database<{ id: string; variantId: string }[]>`
      SELECT id,variant_id AS "variantId" FROM baijiahao_automation_runs
      WHERE source_mode='official_site_derived'
    `;
    const run = runs[0];
    if (!run) throw new Error('Derived Baijiahao automation run was not created');
    const content = Object.freeze({ ...ARTICLE, platform_code: 'baijiahao' as const });
    const hash = contentHash(content);
    await database`
      INSERT INTO content_versions(
        id,tenant_id,package_id,variant_id,version_no,schema_version,
        content_json,content_hash,created_by
      ) VALUES(
        ${DERIVED_REGENERATION_VERSION_ID}::uuid,${TENANT_ID}::uuid,${PACKAGE_ID}::uuid,
        ${run.variantId}::uuid,1,${content.schema_version},
        ${database.json(content)},${hash},${USER_ID}::uuid
      )
    `;
    await database`
      UPDATE content_variants SET
        current_content_version_id=${DERIVED_REGENERATION_VERSION_ID}::uuid,status='generated'
      WHERE id=${run.variantId}::uuid
    `;

    await database.begin((transaction) =>
      automation.queueQualityAfterGeneration(
        transaction,
        independentGenerationEvent(),
        run.variantId,
        DERIVED_REGENERATION_VERSION_ID,
        hash,
        content,
      ),
    );

    expect(
      await database<
        { contentVersionId: string; itemStatus: string; similarity: number; status: string }[]
      >`
        SELECT automation.status,automation.content_version_id AS "contentVersionId",
          automation.source_similarity::float8 AS similarity,item.status AS "itemStatus"
        FROM baijiahao_automation_runs AS automation
        JOIN baijiahao_daily_batch_items AS item
          ON item.automation_run_id=automation.id AND item.tenant_id=automation.tenant_id
        WHERE automation.id=${run.id}::uuid
      `,
    ).toEqual([
      {
        contentVersionId: DERIVED_REGENERATION_VERSION_ID,
        itemStatus: 'quality_check',
        similarity: 1,
        status: 'quality_pending',
      },
    ]);
    await expect(
      automation.loadGatePolicy(database, TENANT_ID, run.variantId),
    ).resolves.toMatchObject({ sourceSimilarity: 1 });
  });

  it('reattaches a manually regenerated candidate retired after generation failure', async () => {
    const database = requireClient(client);
    const generatedHash = await seedGeneratedIndependentCandidate(database);
    await database`
      UPDATE baijiahao_automation_runs SET
        status='disabled',last_error_json=${database.json({
          code: 'CONTENT_GENERATION_FAILED_RETIRED',
          schema_version: 'baijiahao-automation-error@1',
        })},finished_at=now()
      WHERE id=${INDEPENDENT_RUN_ID}::uuid
    `;
    await database`
      UPDATE baijiahao_daily_batch_items SET status='retired'
      WHERE id=${INDEPENDENT_ITEM_ID}::uuid
    `;

    await database.begin((transaction) =>
      createAutomation(database).queueQualityAfterGeneration(
        transaction,
        independentGenerationEvent(),
        INDEPENDENT_VARIANT_ID,
        INDEPENDENT_VERSION_ID,
        generatedHash,
        independentArticle(),
      ),
    );

    await expectIndependentQualityQueued(database);
  });

  it('allows a recoverable non-required automation candidate to be regenerated', async () => {
    const database = requireClient(client);
    await seedGeneratedIndependentCandidate(database);
    await database`
      UPDATE content_variants SET status='generation_failed'
      WHERE id=${INDEPENDENT_VARIANT_ID}::uuid
    `;
    await database`
      UPDATE baijiahao_automation_runs SET
        status='disabled',last_error_json=${database.json({
          code: 'CONTENT_GENERATION_FAILED_RETIRED',
          schema_version: 'baijiahao-automation-error@1',
        })},finished_at=now()
      WHERE id=${INDEPENDENT_RUN_ID}::uuid
    `;
    await database`
      INSERT INTO generation_runs(
        id,tenant_id,workspace_id,project_id,package_id,variant_id,
        skill_name,skill_version,prompt_version_id,model_key,status,
        input_hash,request_id,started_at,finished_at
      ) VALUES(
        ${MANUAL_QUALITY_RUN_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,
        ${PROJECT_ID}::uuid,${PACKAGE_ID}::uuid,${INDEPENDENT_VARIANT_ID}::uuid,
        'quality-checker','1.0.0',${WRITER_PROMPT_ID}::uuid,'deepseek-v4-flash','succeeded',
        ${'e'.repeat(64)},'manual-quality-report',now(),now()
      )
    `;
    await database`
      INSERT INTO quality_reports(
        id,tenant_id,variant_id,content_version_id,generation_run_id,
        checker_version,score,decision,issues_json,geo_scores_json
      ) VALUES(
        ${MANUAL_QUALITY_REPORT_ID}::uuid,${TENANT_ID}::uuid,
        ${INDEPENDENT_VARIANT_ID}::uuid,${INDEPENDENT_VERSION_ID}::uuid,
        ${MANUAL_QUALITY_RUN_ID}::uuid,'1.0.0',72,'block',
        ${database.json({
          issues: [
            {
              category: 'format',
              citation_ids: [],
              location: 'intro',
              message: '开头没有直接回答问题',
              rule_id: 'FORMAT_DIRECT_ANSWER',
              severity: 'BLOCK',
              suggestion: '在首段直接回答标题问题。',
            },
          ],
          schema_version: 'quality-checker-data@1',
        })},
        ${database.json({
          answerability: 72,
          entity: 90,
          evidence: 90,
          platform_fit: 80,
          question: 72,
          readability_safety: 90,
          schema_version: 'geo-scores@1',
          total: 72,
        })}
      )
    `;
    const variants = await database<{ version: number }[]>`
      SELECT version FROM content_variants WHERE id=${INDEPENDENT_VARIANT_ID}::uuid
    `;
    const service = new ContentApiService(
      { client: database } as IdentityAuthDatabase,
      new OutboxWriter(database as never),
    );
    const previousEnvironment = {
      model: process.env['CONTENT_MODEL_BALANCED_KEY'],
      prompt: process.env['CONTENT_WRITER_PROMPT_VERSION_ID'],
      version: process.env['CONTENT_WRITER_SKILL_VERSION'],
    };
    process.env['CONTENT_MODEL_BALANCED_KEY'] = 'deepseek-v4-flash';
    process.env['CONTENT_WRITER_PROMPT_VERSION_ID'] = WRITER_PROMPT_ID;
    process.env['CONTENT_WRITER_SKILL_VERSION'] = '1.0.0';
    try {
      await database.begin((transaction) =>
        service.regenerateVariant(
          transaction,
          TENANT_ID,
          USER_ID,
          INDEPENDENT_VARIANT_ID,
          variants[0]?.version ?? 0,
          {
            locked_block_keys: [],
            model_policy: 'balanced',
            quality_report_id: MANUAL_QUALITY_REPORT_ID,
          },
          { requestId: 'baijiahao-non-required-regeneration' },
        ),
      );
    } finally {
      restoreEnvironment('CONTENT_MODEL_BALANCED_KEY', previousEnvironment.model);
      restoreEnvironment('CONTENT_WRITER_PROMPT_VERSION_ID', previousEnvironment.prompt);
      restoreEnvironment('CONTENT_WRITER_SKILL_VERSION', previousEnvironment.version);
    }

    expect(
      await database<{ events: number; status: string }[]>`
        SELECT variant.status,
          (
            SELECT count(*)::integer FROM outbox_events
            WHERE event_type='content.package.generation_requested.v1'
              AND aggregate_id=${PACKAGE_ID}::uuid
          ) AS events
        FROM content_variants AS variant WHERE variant.id=${INDEPENDENT_VARIANT_ID}::uuid
      `,
    ).toEqual([{ events: 1, status: 'generating' }]);
    const events = await database<{ revision: Record<string, unknown> }[]>`
      SELECT payload_json->'data'->'revision' AS revision
      FROM outbox_events
      WHERE event_type='content.package.generation_requested.v1'
        AND aggregate_id=${PACKAGE_ID}::uuid
      ORDER BY created_at DESC LIMIT 1
    `;
    expect(events[0]?.revision).toMatchObject({
      candidate: {
        master_content: { platform_code: 'master' },
        variants: [{ platform_code: 'baijiahao' }],
      },
      content_version_id: INDEPENDENT_VERSION_ID,
      issues: [expect.stringContaining('FORMAT_DIRECT_ANSWER')],
      quality_report_id: MANUAL_QUALITY_REPORT_ID,
    });
  });

  it('reattaches a stale automation run before a user-requested quality check', async () => {
    const database = requireClient(client);
    const generatedHash = await seedGeneratedIndependentCandidate(database);
    await database`
      UPDATE content_variants SET status='quality_failed'
      WHERE id=${INDEPENDENT_VARIANT_ID}::uuid
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
    process.env['QUALITY_CHECKER_MODEL_KEY'] = 'deepseek-v4-flash';
    process.env['QUALITY_CHECKER_PROMPT_VERSION_ID'] = QUALITY_PROMPT_ID;
    process.env['QUALITY_CHECKER_SKILL_VERSION'] = '1.0.0';
    try {
      await database.begin((transaction) =>
        service.requestQualityCheck(
          transaction,
          TENANT_ID,
          USER_ID,
          INDEPENDENT_VARIANT_ID,
          generatedHash,
          { requestId: 'baijiahao-stale-quality-recovery' },
        ),
      );
    } finally {
      restoreEnvironment('QUALITY_CHECKER_MODEL_KEY', previousEnvironment.model);
      restoreEnvironment('QUALITY_CHECKER_PROMPT_VERSION_ID', previousEnvironment.prompt);
      restoreEnvironment('QUALITY_CHECKER_SKILL_VERSION', previousEnvironment.version);
    }

    await expectIndependentQualityQueued(database);
  });

  it('terminalizes a daily candidate after its content generation fails', async () => {
    const database = requireClient(client);
    await seedGeneratedIndependentCandidate(database);
    await database`
      UPDATE baijiahao_automation_policies SET daily_enabled=true
      WHERE id=${POLICY_ID}::uuid
    `;
    await database`
      UPDATE content_variants SET status='generation_failed'
      WHERE id=${INDEPENDENT_VARIANT_ID}::uuid
    `;
    const scheduler = new BaijiahaoDailyScheduler(
      database,
      {
        qualityModelKey: 'deepseek-v4-flash',
        qualityPromptVersionId: QUALITY_PROMPT_ID,
        qualitySkillVersion: '1.0.0',
        rewriteModelKey: 'deepseek-v4-flash',
        writerPromptVersionId: WRITER_PROMPT_ID,
        writerSkillVersion: '1.0.0',
      },
      { tickMs: 30_000 },
    );

    await expect(scheduler.tick()).resolves.toBeUndefined();

    expect(
      await database<{ code: string; finished: boolean; itemStatus: string; runStatus: string }[]>`
        SELECT automation.status AS "runStatus",automation.finished_at IS NOT NULL AS finished,
          automation.last_error_json->>'code' AS code,item.status AS "itemStatus"
        FROM baijiahao_automation_runs AS automation
        JOIN baijiahao_daily_batch_items AS item
          ON item.tenant_id=automation.tenant_id AND item.automation_run_id=automation.id
        WHERE automation.id=${INDEPENDENT_RUN_ID}::uuid
      `,
    ).toEqual([
      {
        code: 'CONTENT_GENERATION_FAILED_RETIRED',
        finished: true,
        itemStatus: 'retired',
        runStatus: 'disabled',
      },
    ]);
  });

  it('lists manual-required items and resumes quality after user editing', async () => {
    const database = requireClient(client);
    const generatedHash = await seedGeneratedIndependentCandidate(database);
    await database`
      UPDATE content_variants SET status='quality_failed'
      WHERE id=${INDEPENDENT_VARIANT_ID}::uuid
    `;
    await database`
      UPDATE baijiahao_automation_runs SET
        content_version_id=${INDEPENDENT_VERSION_ID}::uuid,status='manual_required',
        rewrite_count=3,last_error_json=${database.json({
          blocking_rules: ['gate.question_coverage'],
          code: 'QUALITY_GATE_FAILED_AFTER_MAX_REWRITES',
          schema_version: 'baijiahao-automation-error@1',
        })},finished_at=now()
      WHERE id=${INDEPENDENT_RUN_ID}::uuid
    `;
    await database`
      UPDATE baijiahao_daily_batch_items SET
        status='manual_required',content_version_id=${INDEPENDENT_VERSION_ID}::uuid,
        last_error_json=${database.json({
          code: 'QUALITY_GATE_FAILED_AFTER_MAX_REWRITES',
          schema_version: 'baijiahao-automation-error@1',
        })}
      WHERE id=${INDEPENDENT_ITEM_ID}::uuid
    `;

    const policies = new BaijiahaoAutomationPolicyService(database, {} as never);
    const policy = (
      await policies.list({ tenantId: TENANT_ID, userId: USER_ID }, BAIJIAHAO_ACCOUNT_ID)
    )[0];
    expect(() => BaijiahaoAutomationPolicyViewSchema.parse(policy)).not.toThrow();
    const before = policy?.today_batch;
    expect(before?.manual_items).toEqual([
      expect.objectContaining({
        automation_run_id: INDEPENDENT_RUN_ID,
        candidate_no: 1,
        content_version_id: INDEPENDENT_VERSION_ID,
        package_id: PACKAGE_ID,
        rewrite_count: 3,
        source_mode: 'independent',
        variant_id: INDEPENDENT_VARIANT_ID,
      }),
    ]);

    const service = new ContentApiService(
      { client: database } as IdentityAuthDatabase,
      new OutboxWriter(database as never),
    );
    await expect(
      service.getVariant(TENANT_ID, USER_ID, INDEPENDENT_VARIANT_ID),
    ).resolves.toMatchObject({
      automation_run: {
        content_version_id: INDEPENDENT_VERSION_ID,
        id: INDEPENDENT_RUN_ID,
        rewrite_count: 3,
        status: 'manual_required',
      },
    });
    const previousEnvironment = {
      model: process.env['QUALITY_CHECKER_MODEL_KEY'],
      prompt: process.env['QUALITY_CHECKER_PROMPT_VERSION_ID'],
      version: process.env['QUALITY_CHECKER_SKILL_VERSION'],
    };
    process.env['QUALITY_CHECKER_MODEL_KEY'] = 'deepseek-v4-flash';
    process.env['QUALITY_CHECKER_PROMPT_VERSION_ID'] = QUALITY_PROMPT_ID;
    process.env['QUALITY_CHECKER_SKILL_VERSION'] = '1.0.0';
    try {
      await database.begin((transaction) =>
        service.requestQualityCheck(
          transaction,
          TENANT_ID,
          USER_ID,
          INDEPENDENT_VARIANT_ID,
          generatedHash,
          { requestId: 'baijiahao-manual-recovery' },
        ),
      );
    } finally {
      restoreEnvironment('QUALITY_CHECKER_MODEL_KEY', previousEnvironment.model);
      restoreEnvironment('QUALITY_CHECKER_PROMPT_VERSION_ID', previousEnvironment.prompt);
      restoreEnvironment('QUALITY_CHECKER_SKILL_VERSION', previousEnvironment.version);
    }

    expect(
      await database<
        { contentVersionId: string; itemStatus: string; rewriteCount: number; runStatus: string }[]
      >`
        SELECT automation.status AS "runStatus",automation.rewrite_count AS "rewriteCount",
          automation.content_version_id AS "contentVersionId",item.status AS "itemStatus"
        FROM baijiahao_automation_runs AS automation
        JOIN baijiahao_daily_batch_items AS item
          ON item.automation_run_id=automation.id AND item.tenant_id=automation.tenant_id
        WHERE automation.id=${INDEPENDENT_RUN_ID}::uuid
      `,
    ).toEqual([
      {
        contentVersionId: INDEPENDENT_VERSION_ID,
        itemStatus: 'quality_check',
        rewriteCount: 0,
        runStatus: 'quality_pending',
      },
    ]);
    expect(
      (await policies.list({ tenantId: TENANT_ID, userId: USER_ID }, BAIJIAHAO_ACCOUNT_ID))[0]
        ?.today_batch?.manual_items,
    ).toEqual([]);
  });

  it('does not turn a browser publication ambiguity into a new quality check', async () => {
    const database = requireClient(client);
    const generatedHash = await seedGeneratedIndependentCandidate(database);
    await database`
      UPDATE content_variants SET status='quality_failed'
      WHERE id=${INDEPENDENT_VARIANT_ID}::uuid
    `;
    await database`
      UPDATE baijiahao_automation_runs SET
        content_version_id=${INDEPENDENT_VERSION_ID}::uuid,status='manual_required',
        last_error_json=${database.json({ code: 'BROWSER_SUBMISSION_AMBIGUOUS' })},finished_at=now()
      WHERE id=${INDEPENDENT_RUN_ID}::uuid
    `;
    const service = new ContentApiService(
      { client: database } as IdentityAuthDatabase,
      new OutboxWriter(database as never),
    );

    await expect(
      database.begin((transaction) =>
        service.requestQualityCheck(
          transaction,
          TENANT_ID,
          USER_ID,
          INDEPENDENT_VARIANT_ID,
          generatedHash,
          { requestId: 'baijiahao-browser-ambiguity' },
        ),
      ),
    ).rejects.toMatchObject({
      kind: 'state',
      message: 'Baijiahao manual state must be resolved from its publication record',
    });
    expect(
      await database<{ code: string; status: string }[]>`
        SELECT status,last_error_json->>'code' AS code FROM baijiahao_automation_runs
        WHERE id=${INDEPENDENT_RUN_ID}::uuid
      `,
    ).toEqual([{ code: 'BROWSER_SUBMISSION_AMBIGUOUS', status: 'manual_required' }]);
  });
});

function createAutomation(database: Sql): BaijiahaoAutomation {
  return new BaijiahaoAutomation(database, {} as never, {
    qualityModelKey: 'deepseek-v4-flash',
    qualityPromptVersionId: QUALITY_PROMPT_ID,
    qualitySkillVersion: '1.0.0',
    rewriteModelKey: 'deepseek-v4-flash',
    writerPromptVersionId: WRITER_PROMPT_ID,
    writerSkillVersion: '1.0.0',
  });
}

function publishedEvent() {
  return {
    aggregate: { id: PUBLISH_JOB_ID, type: 'publish_job' },
    data: {
      account_id: OFFICIAL_ACCOUNT_ID,
      content_version_id: CONTENT_VERSION_ID,
      created_by: USER_ID,
      external_post_id: 't145-official-source',
      external_url: OFFICIAL_URL,
      job_id: PUBLISH_JOB_ID,
      job_version: 2,
      origin: 'official_site_automation',
      package_id: PACKAGE_ID,
      platform_code: 'official_site',
      project_id: PROJECT_ID,
      published_at: '2026-08-02T00:10:00.000Z',
      request_id: 't145-official-published',
      variant_id: OFFICIAL_VARIANT_ID,
      workspace_id: WORKSPACE_ID,
    },
    event_id: 'b1000000-0000-4000-8000-000000000145',
    event_type: 'publishing.job.published.v1',
    occurred_at: '2026-08-02T00:10:00.000Z',
    tenant: { id: TENANT_ID },
  } as const;
}

function independentGenerationEvent(): ValidatedGenerationEvent {
  return {
    data: {
      actorUserId: USER_ID,
      inputHash: '1'.repeat(64),
      masterRunId: 'b2000000-0000-4000-8000-000000000145',
      modelKey: 'deepseek-v4-flash',
      modelPolicy: 'quality',
      packageId: PACKAGE_ID,
      projectId: PROJECT_ID,
      promptVersionId: WRITER_PROMPT_ID,
      requestId: 't145-independent-generation',
      skillVersion: '1.0.0',
      variantRuns: [
        {
          platformCode: 'baijiahao',
          runId: 'b2100000-0000-4000-8000-000000000145',
          variantId: INDEPENDENT_VARIANT_ID,
        },
      ],
      workspaceId: WORKSPACE_ID,
      writerInput: {},
    },
    eventId: 'b2200000-0000-4000-8000-000000000145',
    occurredAt: '2026-08-04T01:03:52.000Z',
    tenantId: TENANT_ID,
  };
}

async function reset(database: Sql): Promise<void> {
  await database`
    TRUNCATE
      baijiahao_browser_artifacts,baijiahao_browser_publications,baijiahao_browser_sessions,
      baijiahao_daily_batch_items,baijiahao_daily_batches,baijiahao_automation_runs,
      baijiahao_automation_policies,publish_attempts,publish_jobs,platform_accounts,
      ai_citations,source_chunks,source_documents,content_versions,content_variants,
      content_packages,briefs,platform_rule_versions,prompt_versions,brand_profiles,
      generation_runs,workspace_memberships,projects,workspaces,audit_events,outbox_events,
      memberships,tenants,users
    CASCADE
  `;
}

async function seed(database: Sql, content: GeneratedContent): Promise<void> {
  const evidence = '广州志远搬家服务有限公司使用服务单记录搬运项目和交接事项。';
  const hash = contentHash(content);
  await database`
    INSERT INTO users(id,email,display_name,status)
    VALUES(${USER_ID}::uuid,'t145@example.com','T145','active')
  `;
  await database`
    INSERT INTO tenants(id,name,slug,status)
    VALUES(${TENANT_ID}::uuid,'T145 Tenant','t145','active')
  `;
  await database`
    INSERT INTO memberships(tenant_id,user_id,role_code,status)
    VALUES(${TENANT_ID}::uuid,${USER_ID}::uuid,'publisher','active')
  `;
  await database`
    INSERT INTO workspaces(id,tenant_id,name,slug,timezone,status)
    VALUES(${WORKSPACE_ID}::uuid,${TENANT_ID}::uuid,'T145','t145','Asia/Shanghai','active')
  `;
  await database`
    INSERT INTO workspace_memberships(workspace_id,user_id,scope_json)
    VALUES(${WORKSPACE_ID}::uuid,${USER_ID}::uuid,'{}'::jsonb)
  `;
  await database`
    INSERT INTO projects(id,tenant_id,workspace_id,name,owner_id,status)
    VALUES(
      ${PROJECT_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,
      'T145 Project',${USER_ID}::uuid,'active'
    )
  `;
  await database`
    INSERT INTO brand_profiles(
      id,tenant_id,workspace_id,version,status,schema_version,
      profile_json,created_by,published_at
    ) VALUES(
      ${BRAND_PROFILE_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,1,'published',
      'brand-profile@1',${database.json({
        audience: ['广州搬家用户'],
        banned: ['其他公司的可识别名称', '无证据承诺'],
        compliance: ['只使用可追溯证据'],
        cta: null,
        differentiators: ['服务单可追溯'],
        positioning: '广州志远搬家服务有限公司',
        tone: '客观、清晰',
      })},${USER_ID}::uuid,now()
    )
  `;
  await database`
    INSERT INTO prompt_versions(
      id,skill_name,version,schema_version,system_prompt,task_template,
      content_hash,status,created_by,published_at
    ) VALUES(
      ${WRITER_PROMPT_ID}::uuid,'content-writer','1.0.0','content-writer-data@1',
      'Adapt verified content.','Use {{writer_input}}.',${'c'.repeat(64)},
      'published',${USER_ID}::uuid,now()
    )
  `;
  await database`
    INSERT INTO platform_rule_versions(
      id,platform_code,version,rules_json,content_hash,status,created_by,published_at
    ) VALUES(
      ${RULE_ID}::uuid,'baijiahao','1.1.0',
      ${database.json({
        external_links: false,
        schema_version: 'platform-rules@1',
        title_max: 40,
      })},${'d'.repeat(64)},'published',${USER_ID}::uuid,now()
    )
  `;
  await database`
    INSERT INTO briefs(
      id,tenant_id,workspace_id,project_id,title,objective,audience,
      platform_codes,constraints_json,created_by
    ) VALUES(
      ${BRIEF_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
      '搬家准备信息','awareness','有搬家计划并希望提前做好准备的广州用户',
      ARRAY['official_site']::varchar[],
      ${database.json({ schema_version: 'brief-constraints@1' })},${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO content_packages(
      id,tenant_id,workspace_id,project_id,brief_id,status,created_by
    ) VALUES(
      ${PACKAGE_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
      ${BRIEF_ID}::uuid,'published',${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO content_variants(
      id,tenant_id,package_id,platform_code,status,is_required
    ) VALUES(
      ${OFFICIAL_VARIANT_ID}::uuid,${TENANT_ID}::uuid,${PACKAGE_ID}::uuid,
      'official_site','published',true
    )
  `;
  await database`
    INSERT INTO content_versions(
      id,tenant_id,package_id,variant_id,version_no,schema_version,
      content_json,content_hash,created_by
    ) VALUES(
      ${CONTENT_VERSION_ID}::uuid,${TENANT_ID}::uuid,${PACKAGE_ID}::uuid,
      ${OFFICIAL_VARIANT_ID}::uuid,1,${content.schema_version},
      ${database.json(content)},${hash},${USER_ID}::uuid
    )
  `;
  await database`
    UPDATE content_variants SET current_content_version_id=${CONTENT_VERSION_ID}::uuid
    WHERE id=${OFFICIAL_VARIANT_ID}::uuid
  `;
  await database`
    INSERT INTO platform_accounts(
      id,tenant_id,workspace_id,platform_code,provider_account_id,display_name,
      capabilities_json,publish_mode,status,timezone
    ) VALUES
      (
        ${OFFICIAL_ACCOUNT_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,
        'official_site','t145-official','官网',${database.json({ publish: true })},
        'api','active','Asia/Shanghai'
      ),
      (
        ${BAIJIAHAO_ACCOUNT_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,
        'baijiahao','t145-baijiahao','百家号',
        ${database.json({ get_status: true, publish: true })},
        'api','active','Asia/Shanghai'
      )
  `;
  await database`
    INSERT INTO baijiahao_automation_policies(
      id,tenant_id,workspace_id,project_id,account_id,enabled,
      source_mode,created_by
    ) VALUES(
      ${POLICY_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
      ${BAIJIAHAO_ACCOUNT_ID}::uuid,true,'official_site_derived',${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO publish_jobs(
      id,tenant_id,variant_id,content_version_id,account_id,scheduled_at,
      idempotency_key,payload_hash,status,origin,external_post_id,external_url,
      published_at,attempt_count,created_by
    ) VALUES(
      ${PUBLISH_JOB_ID}::uuid,${TENANT_ID}::uuid,${OFFICIAL_VARIANT_ID}::uuid,
      ${CONTENT_VERSION_ID}::uuid,${OFFICIAL_ACCOUNT_ID}::uuid,
      '2026-08-02T00:00:00.000Z','t145-official-source',${hash},'published',
      'official_site_automation','t145-official-source',${OFFICIAL_URL},
      '2026-08-02T00:10:00.000Z',1,${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO source_documents(
      id,tenant_id,workspace_id,project_id,title,source_type,mime_type,
      uri,content_hash,trust_level,status,created_by
    ) VALUES(
      ${SOURCE_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
      '志远服务单','txt','text/plain','memory://t145/source',${sha256(evidence)},
      'verified','active',${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO source_chunks(
      id,tenant_id,source_document_id,chunk_no,text,text_hash,
      metadata_json,token_count,status
    ) VALUES(
      ${CHUNK_ID}::uuid,${TENANT_ID}::uuid,${SOURCE_ID}::uuid,0,${evidence},
      ${sha256(evidence)},${database.json({
        char_end: evidence.length,
        char_start: 0,
        schema_version: 'chunk-metadata@1',
      })},32,'active'
    )
  `;
  await database`
    INSERT INTO ai_citations(
      id,tenant_id,content_version_id,claim_key,claim_text,
      chunk_id,quote_text,quote_hash
    ) VALUES(
      ${CITATION_ID}::uuid,${TENANT_ID}::uuid,${CONTENT_VERSION_ID}::uuid,
      'service-record',${evidence},${CHUNK_ID}::uuid,${evidence},${sha256(evidence)}
    )
  `;
}

async function seedGeneratedIndependentCandidate(database: Sql): Promise<string> {
  const content = independentArticle();
  const hash = contentHash(content);
  await database`
    UPDATE baijiahao_automation_policies SET independent_fallback_enabled=true
    WHERE id=${POLICY_ID}::uuid
  `;
  await database`
    INSERT INTO content_variants(
      id,tenant_id,package_id,platform_code,platform_account_id,status,is_required
    ) VALUES(
      ${INDEPENDENT_VARIANT_ID}::uuid,${TENANT_ID}::uuid,${PACKAGE_ID}::uuid,
      'baijiahao',${BAIJIAHAO_ACCOUNT_ID}::uuid,'generated',false
    )
  `;
  await database`
    INSERT INTO content_versions(
      id,tenant_id,package_id,variant_id,version_no,schema_version,
      content_json,content_hash,created_by
    ) VALUES(
      ${INDEPENDENT_VERSION_ID}::uuid,${TENANT_ID}::uuid,${PACKAGE_ID}::uuid,
      ${INDEPENDENT_VARIANT_ID}::uuid,1,${content.schema_version},
      ${database.json(content)},${hash},${USER_ID}::uuid
    )
  `;
  await database`
    UPDATE content_variants SET current_content_version_id=${INDEPENDENT_VERSION_ID}::uuid
    WHERE id=${INDEPENDENT_VARIANT_ID}::uuid
  `;
  await database`
    INSERT INTO baijiahao_automation_runs(
      id,tenant_id,policy_id,source_mode,variant_id,status
    ) VALUES(
      ${INDEPENDENT_RUN_ID}::uuid,${TENANT_ID}::uuid,${POLICY_ID}::uuid,
      'independent',${INDEPENDENT_VARIANT_ID}::uuid,'generation_pending'
    )
  `;
  await database`
    INSERT INTO baijiahao_daily_batches(
      id,tenant_id,policy_id,business_date,status
    ) VALUES(
      ${INDEPENDENT_BATCH_ID}::uuid,${TENANT_ID}::uuid,${POLICY_ID}::uuid,
      (now() AT TIME ZONE 'Asia/Shanghai')::date,'running'
    )
  `;
  await database`
    INSERT INTO baijiahao_daily_batch_items(
      id,tenant_id,batch_id,candidate_no,automation_run_id,brief_id,
      package_id,variant_id,status
    ) VALUES(
      ${INDEPENDENT_ITEM_ID}::uuid,${TENANT_ID}::uuid,${INDEPENDENT_BATCH_ID}::uuid,1,
      ${INDEPENDENT_RUN_ID}::uuid,${BRIEF_ID}::uuid,${PACKAGE_ID}::uuid,
      ${INDEPENDENT_VARIANT_ID}::uuid,'generating'
    )
  `;
  return hash;
}

function independentArticle(): GeneratedContent {
  return Object.freeze({
    ...ARTICLE,
    platform_code: 'baijiahao' as const,
    title: '广州搬家前如何系统准备',
  });
}

async function seedOtherInProgressAutomation(database: Sql): Promise<void> {
  await database`
    INSERT INTO briefs(
      id,tenant_id,workspace_id,project_id,title,objective,audience,
      platform_codes,constraints_json,created_by
    ) VALUES(
      ${OTHER_BRIEF_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
      '百家号补位候选','awareness','有搬家计划并希望提前做好准备的广州用户',
      ARRAY['baijiahao']::varchar[],
      ${database.json({ schema_version: 'brief-constraints@1' })},${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO content_packages(
      id,tenant_id,workspace_id,project_id,brief_id,status,created_by
    ) VALUES(
      ${OTHER_PACKAGE_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
      ${OTHER_BRIEF_ID}::uuid,'generating',${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO content_variants(
      id,tenant_id,package_id,platform_code,platform_account_id,status,is_required
    ) VALUES(
      ${OTHER_VARIANT_ID}::uuid,${TENANT_ID}::uuid,${OTHER_PACKAGE_ID}::uuid,
      'baijiahao',${BAIJIAHAO_ACCOUNT_ID}::uuid,'generating',false
    )
  `;
  await database`
    INSERT INTO baijiahao_automation_runs(
      id,tenant_id,policy_id,source_mode,variant_id,status
    ) VALUES(
      ${OTHER_RUN_ID}::uuid,${TENANT_ID}::uuid,${POLICY_ID}::uuid,
      'independent',${OTHER_VARIANT_ID}::uuid,'generation_pending'
    )
  `;
}

async function expectIndependentQualityQueued(database: Sql): Promise<void> {
  expect(
    await database<{ contentVersionId: string; itemStatus: string; runStatus: string }[]>`
      SELECT automation.status AS "runStatus",item.status AS "itemStatus",
        automation.content_version_id AS "contentVersionId"
      FROM baijiahao_automation_runs AS automation
      JOIN baijiahao_daily_batch_items AS item
        ON item.automation_run_id=automation.id AND item.tenant_id=automation.tenant_id
      WHERE automation.id=${INDEPENDENT_RUN_ID}::uuid
    `,
  ).toEqual([
    {
      contentVersionId: INDEPENDENT_VERSION_ID,
      itemStatus: 'quality_check',
      runStatus: 'quality_pending',
    },
  ]);
  expect(
    await database<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM outbox_events
      WHERE event_type='content.variant.quality_check_requested.v1'
        AND aggregate_id=${INDEPENDENT_VARIANT_ID}::uuid
    `,
  ).toEqual([{ count: 1 }]);
}

function article(): GeneratedContent {
  const paragraph =
    '搬家准备应围绕物品清点、通道核对、包装标记、现场交接和服务单留存展开。每一步都应以现场条件和双方确认的信息为准，不把未经核验的价格、规模、资质或服务承诺写入说明。';
  return Object.freeze({
    blocks: Object.freeze([
      Object.freeze({ block_key: 'intro', block_type: 'heading', text: '搬家前如何系统准备' }),
      ...Array.from({ length: 6 }, (_, index) =>
        Object.freeze({
          block_key: `section-${index + 1}`,
          block_type: 'paragraph' as const,
          text: `${index + 1}、${paragraph.repeat(2)}`,
        }),
      ),
    ]),
    citation_map: Object.freeze([
      Object.freeze({
        citation_ids: Object.freeze([CITATION_ID]),
        claim_key: 'service-record',
        claim_text: '服务单记录搬运项目和交接事项',
      }),
    ]),
    cta: null,
    hashtags: Object.freeze([]),
    platform_code: 'official_site',
    platform_meta: Object.freeze({}),
    schema_version: 'content-writer-data@1',
    summary: '从物品、通道、包装、交接和服务单五个方面说明搬家准备方法。',
    title: '搬家前如何系统准备',
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requireClient(value: Sql | undefined): Sql {
  if (!value) throw new Error('Baijiahao automation PostgreSQL client was not initialized');
  return value;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
