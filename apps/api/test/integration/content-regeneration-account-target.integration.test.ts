import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import postgres, { type Sql } from 'postgres';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import { ContentApiService } from '../../src/modules/content/api/content-api.service.js';
import type { IdentityAuthDatabase } from '../../src/modules/identity/auth/auth.database.js';
import { OutboxWriter } from '../../src/modules/outbox/index.js';
import { AccountContentPolicyService } from '../../src/modules/publishing/accounts/account-content-policy.service.js';
import { dailyEditorialContext } from '../../../../workers/ai/src/daily-editorial-context.js';

const USER_ID = '13000000-0000-4000-8000-000000000321';
const TENANT_ID = '23000000-0000-4000-8000-000000000321';
const WORKSPACE_ID = '33000000-0000-4000-8000-000000000321';
const PROJECT_ID = '43000000-0000-4000-8000-000000000321';
const BRIEF_ID = '53000000-0000-4000-8000-000000000321';
const PACKAGE_ID = '63000000-0000-4000-8000-000000000321';
const VARIANT_ID = '73000000-0000-4000-8000-000000000321';
const TARGET_ACCOUNT_ID = '83000000-0000-4000-8000-000000000321';
const OTHER_ACCOUNT_ID = '84000000-0000-4000-8000-000000000321';
const BRAND_ID = '93000000-0000-4000-8000-000000000321';
const WRITER_PROMPT_ID = '25000000-0000-4000-8000-000000000008';

describe('content regeneration account targeting', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), {
      max: 4,
      onnotice: () => undefined,
      prepare: false,
    });
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`TRUNCATE outbox_events, tenants, users CASCADE`;
    await seed(database);
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('preserves raw recommendation quotes in manual and daily events for citation persistence', async () => {
    const database = requireClient(client);
    const quote =
      '提供日式搬迁。\n\n半日式包含整理、收纳并放到指定房间。\n\n家具或电器拆装另收费。';
    const companies = [];
    for (const name of ['广州测试甲有限公司', '广州测试乙有限公司']) {
      const sourceId = randomUUID(),
        chunkId = randomUUID();
      const hash = createHash('sha256').update(quote).digest('hex');
      const documentHash = createHash('sha256')
        .update(name + quote)
        .digest('hex');
      companies.push({ id: randomUUID(), legal_name: name, source_document_ids: [sourceId] });
      await database`INSERT INTO source_documents(id,tenant_id,workspace_id,project_id,title,source_type,mime_type,uri,content_hash,trust_level,status,created_by)
        VALUES(${sourceId},${TENANT_ID},${WORKSPACE_ID},${PROJECT_ID},${name},'txt','text/plain',${`memory://${sourceId}`},${documentHash},'verified','active',${USER_ID})`;
      await database`INSERT INTO source_chunks(id,tenant_id,source_document_id,chunk_no,text,text_hash,metadata_json,token_count,status)
        VALUES(${chunkId},${TENANT_ID},${sourceId},0,${quote},${hash},${database.json({ schema_version: 'chunk-metadata@1', char_start: 0, char_end: quote.length })},40,'active')`;
    }
    const scope = {
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
    };
    await database.begin((tx) =>
      new AccountContentPolicyService(database).saveInTransaction(
        tx,
        scope,
        TARGET_ACCOUNT_ID,
        {
          expected_version: 0,
          default_style: 'company_recommendation',
          recommended_companies: companies,
        },
        { requestId: 'raw-recommendation-policy' },
      ),
    );
    await withGenerationEnvironment(() => regenerate(database, 'raw-recommendation-quote'));
    const [row] =
      await database`SELECT payload_json->'data'->'writer_input' AS input FROM outbox_events WHERE tenant_id=${TENANT_ID} AND event_type='content.package.generation_requested.v1'`;
    expect(row!.input.citations.map((item: { quote_text: string }) => item.quote_text)).toEqual([
      quote,
      quote,
    ]);
    const daily = await database.begin((tx) =>
      dailyEditorialContext(
        tx,
        {
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          projectId: PROJECT_ID,
          createdBy: USER_ID,
          accountId: TARGET_ACCOUNT_ID,
          editorialContext: row!.input.brief.constraints.editorial_contexts_by_code.douyin,
        },
        'douyin',
      ),
    );
    expect(daily.citations.map((item) => item.quoteText)).toEqual([quote, quote]);
  });

  it('regenerates with the frozen account when the workspace has two active Douyin accounts', async () => {
    const database = requireClient(client);

    await withGenerationEnvironment(async () => {
      await expect(regenerate(database, 'regenerate-frozen-douyin-target')).resolves.toMatchObject({
        status: 'queued',
      });
    });

    expect(
      await database<{ accountId: string; status: string }[]>`
        SELECT platform_account_id AS "accountId",status
        FROM content_variants
        WHERE id=${VARIANT_ID}::uuid AND tenant_id=${TENANT_ID}::uuid
      `,
    ).toEqual([{ accountId: TARGET_ACCOUNT_ID, status: 'generating' }]);
    expect(
      await database<{ accountId: string }[]>`
        SELECT payload_json->'data'->'writer_input'->'brief'->'constraints'
          ->'target_accounts_by_code'->'douyin'->>'account_id' AS "accountId"
        FROM outbox_events
        WHERE tenant_id=${TENANT_ID}::uuid
          AND event_type='content.package.generation_requested.v1'
      `,
    ).toEqual([{ accountId: TARGET_ACCOUNT_ID }]);
  });

  it('does not trust customer-editable Brief fields as server-owned editorial context', async () => {
    const database = requireClient(client);
    await database`UPDATE briefs SET constraints_json=jsonb_set(constraints_json,'{editorial_contexts_by_code}','{"douyin":{"style":"company_recommendation","companies":[{"legal_name":"伪造公司"}]}}'::jsonb) WHERE id=${BRIEF_ID}::uuid`;
    await withGenerationEnvironment(async () => {
      await regenerate(database, 'ignore-untrusted-editorial-context');
    });
    const [row] = await database<{ style: string; companies: unknown[] }[]>`
      SELECT payload_json->'data'->'writer_input'->'brief'->'constraints'->'editorial_contexts_by_code'->'douyin'->>'style' AS style,
        payload_json->'data'->'writer_input'->'brief'->'constraints'->'editorial_contexts_by_code'->'douyin'->'companies' AS companies
      FROM outbox_events WHERE tenant_id=${TENANT_ID}::uuid AND event_type='content.package.generation_requested.v1'
    `;
    expect(row).toEqual({ style: 'standard', companies: [] });
  });

  it('keeps the single-active-account boundary when the Brief has no frozen target', async () => {
    const database = requireClient(client);
    await database`
      UPDATE briefs
      SET constraints_json=constraints_json-'target_accounts_by_code'
      WHERE id=${BRIEF_ID}::uuid AND tenant_id=${TENANT_ID}::uuid
    `;

    await withGenerationEnvironment(async () => {
      await expect(regenerate(database, 'regenerate-without-frozen-target')).rejects.toMatchObject({
        kind: 'state',
        message: 'Platform douyin requires exactly one active account before generation',
      });
    });
  });

  it('keeps resolving the only active account when the Brief has no frozen target', async () => {
    const database = requireClient(client);
    await database`
      DELETE FROM platform_accounts
      WHERE id=${OTHER_ACCOUNT_ID}::uuid AND tenant_id=${TENANT_ID}::uuid
    `;
    await database`
      UPDATE briefs
      SET constraints_json=constraints_json-'target_accounts_by_code'
      WHERE id=${BRIEF_ID}::uuid AND tenant_id=${TENANT_ID}::uuid
    `;

    await withGenerationEnvironment(async () => {
      await expect(
        regenerate(database, 'regenerate-single-account-fallback'),
      ).resolves.toMatchObject({
        status: 'queued',
      });
    });

    expect(
      await database<{ accountId: string }[]>`
        SELECT platform_account_id AS "accountId" FROM content_variants
        WHERE id=${VARIANT_ID}::uuid AND tenant_id=${TENANT_ID}::uuid
      `,
    ).toEqual([{ accountId: TARGET_ACCOUNT_ID }]);
  });

  it('rejects a frozen target that is no longer active', async () => {
    const database = requireClient(client);
    await database`
      UPDATE platform_accounts SET status='disabled'
      WHERE id=${TARGET_ACCOUNT_ID}::uuid AND tenant_id=${TENANT_ID}::uuid
    `;

    await withGenerationEnvironment(async () => {
      await expect(regenerate(database, 'regenerate-disabled-frozen-target')).rejects.toMatchObject(
        {
          kind: 'state',
          message: 'Platform douyin target account is unavailable',
        },
      );
    });
  });

  it('rejects a frozen target that differs from the existing variant binding', async () => {
    const database = requireClient(client);
    await database`
      UPDATE content_variants SET platform_account_id=${OTHER_ACCOUNT_ID}::uuid
      WHERE id=${VARIANT_ID}::uuid AND tenant_id=${TENANT_ID}::uuid
    `;

    await withGenerationEnvironment(async () => {
      await expect(
        regenerate(database, 'regenerate-mismatched-frozen-target'),
      ).rejects.toMatchObject({
        kind: 'state',
        message: 'Variant target account does not match the Brief target account',
      });
    });

    expect(
      await database<
        { accountId: string; packageStatus: string; runCount: number; variantStatus: string }[]
      >`
        SELECT variant.platform_account_id AS "accountId",variant.status AS "variantStatus",
          package.status AS "packageStatus",
          (SELECT count(*)::integer FROM generation_runs
            WHERE package_id=${PACKAGE_ID}::uuid) AS "runCount"
        FROM content_variants AS variant
        JOIN content_packages AS package
          ON package.id=variant.package_id AND package.tenant_id=variant.tenant_id
        WHERE variant.id=${VARIANT_ID}::uuid AND variant.tenant_id=${TENANT_ID}::uuid
      `,
    ).toEqual([
      {
        accountId: OTHER_ACCOUNT_ID,
        packageStatus: 'generated',
        runCount: 0,
        variantStatus: 'quality_passed',
      },
    ]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM outbox_events
        WHERE tenant_id=${TENANT_ID}::uuid
      `,
    ).toEqual([{ count: 0 }]);
  });

  it('rejects an explicitly malformed frozen-target map instead of falling back', async () => {
    const database = requireClient(client);
    await database`
      UPDATE briefs
      SET constraints_json=jsonb_set(constraints_json,'{target_accounts_by_code}','null'::jsonb)
      WHERE id=${BRIEF_ID}::uuid AND tenant_id=${TENANT_ID}::uuid
    `;

    await withGenerationEnvironment(async () => {
      await expect(
        regenerate(database, 'regenerate-malformed-frozen-targets'),
      ).rejects.toMatchObject({
        kind: 'state',
        message: 'Brief target accounts are invalid',
      });
    });
  });
});

async function regenerate(database: Sql, requestId: string) {
  const service = new ContentApiService(
    { client: database } as IdentityAuthDatabase,
    new OutboxWriter(database as never),
  );
  return database.begin((transaction) =>
    service.regenerateVariant(
      transaction,
      TENANT_ID,
      USER_ID,
      VARIANT_ID,
      1,
      { locked_block_keys: [], model_policy: 'balanced' },
      { requestId },
    ),
  );
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users(id,email,display_name,status)
    VALUES(${USER_ID}::uuid,'regenerate-account@example.com','Regenerate Account','active')
  `;
  await database`
    INSERT INTO tenants(id,name,slug,status)
    VALUES(${TENANT_ID}::uuid,'Regeneration Tenant','regeneration-tenant-321','active')
  `;
  await database`
    INSERT INTO memberships(tenant_id,user_id,role_code,status)
    VALUES(${TENANT_ID}::uuid,${USER_ID}::uuid,'publisher','active')
  `;
  await database`
    INSERT INTO workspaces(id,tenant_id,name,slug,timezone,status)
    VALUES(
      ${WORKSPACE_ID}::uuid,${TENANT_ID}::uuid,'Regeneration Workspace',
      'regeneration-workspace-321','Asia/Shanghai','active'
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
      'Douyin Regeneration',${USER_ID}::uuid,'active'
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
        positioning: '广州示例搬家公司提供广州本地搬家服务',
        tone: '专业、实用',
      })},
      ${USER_ID}::uuid,now()
    )
  `;
  await database`
    INSERT INTO platform_accounts(
      id,tenant_id,workspace_id,platform_code,provider_account_id,
      display_name,capabilities_json,publish_mode,status,timezone
    ) VALUES
      (
        ${TARGET_ACCOUNT_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,'douyin',
        'douyin-target','抖音主账号','{"publish":true}'::jsonb,'api','active','Asia/Shanghai'
      ),
      (
        ${OTHER_ACCOUNT_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,'douyin',
        'douyin-other','抖音第二账号','{"publish":true}'::jsonb,'api','active','Asia/Shanghai'
      )
  `;
  await database`
    INSERT INTO briefs(
      id,tenant_id,workspace_id,project_id,title,objective,audience,
      platform_codes,constraints_json,generation_mode,created_by
    ) VALUES(
      ${BRIEF_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
      '广州企业搬家准备事项','awareness','准备了解广州企业搬家服务的潜在客户',
      ARRAY['douyin']::varchar[],
      ${database.json({
        douyin_daily_direct: true,
        schema_version: 'brief-constraints@1',
        target_accounts_by_code: {
          douyin: {
            account_id: TARGET_ACCOUNT_ID,
            capabilities: { publish: true },
            display_name: '抖音主账号',
            provider_account_id: 'douyin-target',
            timezone: 'Asia/Shanghai',
          },
        },
      })},
      'draft',${USER_ID}::uuid
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
      id,tenant_id,package_id,platform_code,status,is_required,platform_account_id
    ) VALUES(
      ${VARIANT_ID}::uuid,${TENANT_ID}::uuid,${PACKAGE_ID}::uuid,'douyin',
      'quality_passed',true,${TARGET_ACCOUNT_ID}::uuid
    )
  `;
}

async function withGenerationEnvironment<T>(operation: () => Promise<T>): Promise<T> {
  const previous = {
    accountRequirement: process.env['CONTENT_REQUIRE_PLATFORM_ACCOUNTS'],
    model: process.env['CONTENT_MODEL_BALANCED_KEY'],
    prompt: process.env['CONTENT_WRITER_PROMPT_VERSION_ID'],
    skill: process.env['CONTENT_WRITER_SKILL_VERSION'],
  };
  process.env['CONTENT_REQUIRE_PLATFORM_ACCOUNTS'] = 'true';
  process.env['CONTENT_MODEL_BALANCED_KEY'] = 'deepseek-v4-flash';
  process.env['CONTENT_WRITER_PROMPT_VERSION_ID'] = WRITER_PROMPT_ID;
  process.env['CONTENT_WRITER_SKILL_VERSION'] = '1.0.0';
  try {
    return await operation();
  } finally {
    restoreEnvironment('CONTENT_REQUIRE_PLATFORM_ACCOUNTS', previous.accountRequirement);
    restoreEnvironment('CONTENT_MODEL_BALANCED_KEY', previous.model);
    restoreEnvironment('CONTENT_WRITER_PROMPT_VERSION_ID', previous.prompt);
    restoreEnvironment('CONTENT_WRITER_SKILL_VERSION', previous.skill);
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('PostgreSQL client is not initialized');
  return client;
}
