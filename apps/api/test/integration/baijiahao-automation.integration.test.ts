import { BaijiahaoAutomation, contentHash, type GeneratedContent } from '@geo-content-os/worker-ai';
import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import { createHash } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';

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
