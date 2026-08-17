import {
  CredentialEnvelopeService,
  LocalCredentialKms,
} from '@geo-content-os/security/credentials';
import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import { randomBytes } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import { ContentApiService } from '../../src/modules/content/api/content-api.service.js';
import type { IdentityAuthDatabase } from '../../src/modules/identity/auth/auth.database.js';
import { OutboxWriter } from '../../src/modules/outbox/index.js';
import {
  BrowserPlatformAutomationPolicyService,
  OfficialSiteAutomationPolicyService,
  PlatformAccountService,
  type PlatformAccountConnector,
  type PlatformAccountScope,
} from '../../src/modules/publishing/accounts/index.js';
import { PlatformDeliveryAccountConnector } from '../../src/modules/publishing/accounts/platform-account.connector.js';

const USER_ID = '11000000-0000-4000-8000-000000000123';
const OTHER_USER_ID = '12000000-0000-4000-8000-000000000123';
const TENANT_ID = '21000000-0000-4000-8000-000000000123';
const WORKSPACE_ID = '31000000-0000-4000-8000-000000000123';
const OTHER_WORKSPACE_ID = '32000000-0000-4000-8000-000000000123';
const PROJECT_ID = '41000000-0000-4000-8000-000000000123';
const DAILY_BRIEF_ID = '51000000-0000-4000-8000-000000000123';
const DAILY_PACKAGE_ID = '61000000-0000-4000-8000-000000000123';
const DAILY_VARIANT_ID = '71000000-0000-4000-8000-000000000123';
const WRITER_PROMPT_ID = '25000000-0000-4000-8000-000000000008';
const QUALITY_PROMPT_ID = '25000000-0000-4000-8000-000000000007';
const SECRET = 'platform-secret-123';
const ROTATED_SECRET = 'platform-secret-rotated-456';

const SCOPE: PlatformAccountScope = { tenantId: TENANT_ID, userId: USER_ID };
const OTHER_SCOPE: PlatformAccountScope = { tenantId: TENANT_ID, userId: OTHER_USER_ID };

describe('platform accounts', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  let kms: LocalCredentialKms | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 4, prepare: false });
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`
      TRUNCATE
        export_artifacts, publish_attempts, publish_jobs, media_assets, platform_accounts,
        workspace_memberships, projects, workspaces, audit_events, memberships, tenants, users
      CASCADE
    `;
    await seed(database);
    kms?.destroy();
    kms = new LocalCredentialKms('test-v1', { 'test-v1': randomBytes(32) });
  });

  afterAll(async () => {
    kms?.destroy();
    await client?.end();
    await container?.stop();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('supports the complete account lifecycle without exposing credentials', async () => {
    const database = requireClient(client);
    const service = createService(database, requireKms(kms));
    const connected = await service.create(
      SCOPE,
      {
        credential: { access_token: SECRET },
        display_name: 'Official Site',
        platform_code: 'official_site',
        publishing_url: 'https://cms.example.test/publish',
        publish_mode: 'api',
        timezone: 'Asia/Shanghai',
        workspace_id: WORKSPACE_ID,
      },
      { requestId: 'req-account-connect' },
    );

    expect(connected).toMatchObject({
      capabilities: { publish: true },
      platform_code: 'official_site',
      publishing_url: 'https://cms.example.test/publish',
      status: 'active',
      version: 1,
      workspace_id: WORKSPACE_ID,
    });
    expect(JSON.stringify(connected)).not.toContain(SECRET);
    expect(connected).not.toHaveProperty('credential');
    expect(connected).not.toHaveProperty('credential_ciphertext');

    const stored = await database<
      { credential_ciphertext: string; credential_key_version: string; version: number }[]
    >`SELECT credential_ciphertext, credential_key_version, version FROM platform_accounts WHERE id=${connected.id}::uuid`;
    expect(stored[0]).toMatchObject({ credential_key_version: 'test-v1', version: 1 });
    expect(stored[0]?.credential_ciphertext).not.toContain(SECRET);

    const listed = await service.list(SCOPE, { workspaceId: WORKSPACE_ID });
    expect(listed).toEqual([connected]);
    expect(JSON.stringify(listed)).not.toContain(SECRET);

    const refreshed = await service.refresh(SCOPE, connected.id, {}, 1, {
      requestId: 'req-account-refresh',
    });
    expect(refreshed).toMatchObject({ version: 2, status: 'active' });

    const tested = await service.test(SCOPE, connected.id, 2, {
      requestId: 'req-account-test',
    });
    expect(tested.account).toMatchObject({ version: 3, capabilities: { publish: true } });
    expect(tested.checkedAt).toBeInstanceOf(Date);

    const updated = await service.update(
      SCOPE,
      connected.id,
      {
        credential: { access_token: ROTATED_SECRET },
        display_name: 'Official Site Main',
        publishing_url: 'https://cms.example.test/articles/new',
        publish_mode: 'api',
        timezone: 'Asia/Hong_Kong',
      },
      3,
      { requestId: 'req-account-update' },
    );
    expect(updated).toMatchObject({
      display_name: 'Official Site Main',
      publishing_url: 'https://cms.example.test/articles/new',
      timezone: 'Asia/Hong_Kong',
      version: 4,
    });

    await expect(
      service.disable(SCOPE, connected.id, 'stale request', 3, {
        requestId: 'req-account-stale',
      }),
    ).rejects.toMatchObject({
      code: 'PLATFORM_ACCOUNT_VERSION_CONFLICT',
    });

    const disabled = await service.disable(SCOPE, connected.id, 'rotated account', 4, {
      requestId: 'req-account-disable',
    });
    expect(disabled).toMatchObject({ status: 'disabled', version: 5 });
    await expect(
      service.test(SCOPE, connected.id, 5, { requestId: 'req-account-disabled-test' }),
    ).rejects.toMatchObject({
      code: 'PLATFORM_ACCOUNT_STATE_INVALID',
    });

    const editedWhileDisabled = await service.update(
      SCOPE,
      connected.id,
      {
        display_name: 'Official Site Standby',
        publish_mode: 'api',
        timezone: 'Asia/Shanghai',
      },
      5,
      { requestId: 'req-account-disabled-update' },
    );
    expect(editedWhileDisabled).toMatchObject({ status: 'disabled', version: 6 });

    const restored = await service.restore(SCOPE, connected.id, 6, {
      requestId: 'req-account-restore',
    });
    expect(restored).toMatchObject({ status: 'active', version: 7 });

    const removed = await service.remove(SCOPE, connected.id, 7, {
      requestId: 'req-account-remove',
    });
    expect(removed).toMatchObject({ status: 'disabled', version: 8 });
    await expect(service.list(SCOPE)).resolves.toEqual([]);

    const audits = await database<
      { action: string; after_json: Record<string, unknown>; before_json: unknown }[]
    >`SELECT action, before_json, after_json FROM audit_events WHERE resource_id=${connected.id}::uuid ORDER BY created_at,id`;
    expect(audits.map(({ action }) => action)).toEqual([
      'platform_account.connected',
      'platform_account.refreshed',
      'platform_account.capability_tested',
      'platform_account.updated',
      'platform_account.disabled',
      'platform_account.updated',
      'platform_account.restored',
      'platform_account.removed',
    ]);
    expect(JSON.stringify(audits)).not.toContain(SECRET);
    expect(JSON.stringify(audits)).not.toContain(ROTATED_SECRET);
    expect(audits[0]?.before_json).toBeNull();
  });

  it('enforces workspace scope for reads and writes', async () => {
    const database = requireClient(client);
    const service = createService(database, requireKms(kms));
    const connected = await service.create(
      SCOPE,
      {
        credential: { access_token: SECRET },
        display_name: 'Scoped Account',
        platform_code: 'zhihu',
        publish_mode: 'api',
        timezone: 'Asia/Shanghai',
        workspace_id: WORKSPACE_ID,
      },
      { requestId: 'req-account-scope' },
    );

    await expect(service.list(OTHER_SCOPE)).resolves.toEqual([]);
    await expect(
      service.test(OTHER_SCOPE, connected.id, 1, { requestId: 'req-account-denied' }),
    ).rejects.toMatchObject({
      code: 'PLATFORM_ACCOUNT_NOT_FOUND',
    });
    await expect(
      service.create(
        OTHER_SCOPE,
        {
          credential: { access_token: SECRET },
          display_name: 'Denied Account',
          platform_code: 'zhihu',
          publish_mode: 'api',
          timezone: 'Asia/Shanghai',
          workspace_id: WORKSPACE_ID,
        },
        { requestId: 'req-account-create-denied' },
      ),
    ).rejects.toMatchObject({
      code: 'PLATFORM_ACCOUNT_NOT_FOUND',
    });
  });

  it('persists official-site connector results with empty scopes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ get_status: true, metrics: false, publish: true }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
          }),
        ),
      ),
    );
    const database = requireClient(client);
    const service = new PlatformAccountService(
      database,
      new CredentialEnvelopeService(requireKms(kms)),
      new PlatformDeliveryAccountConnector(),
    );
    const credential = {
      base_url: 'https://cms.example.test/api/geo/v1/',
      bearer_token: SECRET,
    };
    const connected = await service.create(
      SCOPE,
      {
        credential,
        display_name: 'Production Official Site',
        platform_code: 'official_site',
        publishing_url: 'https://cms.example.test/webadmin/articleEdit',
        publish_mode: 'api',
        timezone: 'Asia/Shanghai',
        workspace_id: WORKSPACE_ID,
      },
      { requestId: 'req-real-connector-create' },
    );

    const updated = await service.update(
      SCOPE,
      connected.id,
      {
        credential,
        display_name: 'Production Official Site Updated',
        publishing_url: 'https://cms.example.test/webadmin/articleEdit',
        publish_mode: 'api',
        timezone: 'Asia/Shanghai',
      },
      connected.version,
      { requestId: 'req-real-connector-update' },
    );

    expect(updated).toMatchObject({
      capabilities: {
        get_status: true,
        metrics: false,
        publish: true,
      },
      display_name: 'Production Official Site Updated',
      scopes: [],
      status: 'active',
      version: 2,
    });
  });

  it('stores Lieju official API credentials without probing or exposing the API key', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network must not be used')));
    vi.stubGlobal('fetch', fetchSpy);
    const database = requireClient(client);
    const envelope = new CredentialEnvelopeService(requireKms(kms));
    const service = new PlatformAccountService(
      database,
      envelope,
      new PlatformDeliveryAccountConnector(),
    );
    const apiKey = 'lieju-official-key-1234567890';

    const connected = await service.create(
      SCOPE,
      {
        credential: {
          api_key: apiKey,
          delivery_method: 'official_api',
          posting_profile: {
            contact_name: '广州志远搬家服务有限公司',
            mobile_phone: '02085627757',
            qq: '',
            wechat: '',
            zone_id: '76',
          },
        },
        display_name: '列举网官方 API',
        platform_code: 'lieju',
        publish_mode: 'api',
        timezone: 'Asia/Shanghai',
        workspace_id: WORKSPACE_ID,
      },
      { requestId: 'req-lieju-official-api' },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(connected).toMatchObject({
      capabilities: {
        delivery_method: 'official_api',
        get_status: false,
        publish: true,
      },
      status: 'active',
    });
    expect(JSON.stringify(connected)).not.toContain(apiKey);
    const rows = await database<{ credentialCiphertext: string; credentialKeyVersion: string }[]>`
      SELECT credential_ciphertext AS "credentialCiphertext",
        credential_key_version AS "credentialKeyVersion"
      FROM platform_accounts WHERE id=${connected.id}::uuid
    `;
    const stored = rows[0];
    if (!stored) throw new Error('Lieju credential was not stored');
    const decrypted = JSON.parse(await envelope.decrypt(stored)) as Record<string, unknown>;
    expect(decrypted).toMatchObject({
      api_key: apiKey,
      city_id: '5',
      delivery_method: 'official_api',
      fid: '73',
    });
  });

  it('retries only an empty browser-platform batch blocked by missing prerequisites', async () => {
    const database = requireClient(client);
    const accounts = new PlatformAccountService(
      database,
      new CredentialEnvelopeService(requireKms(kms)),
      new PlatformDeliveryAccountConnector(),
    );
    const policies = new BrowserPlatformAutomationPolicyService(database);
    const account = await accounts.create(
      SCOPE,
      {
        credential: {
          api_key: 'lieju-retry-test-api-key',
          delivery_method: 'official_api',
          posting_profile: {
            contact_name: '测试搬家服务公司',
            mobile_phone: '02000000000',
            qq: '',
            wechat: '',
            zone_id: '76',
          },
        },
        display_name: '列举网每日批次重试测试',
        platform_code: 'lieju',
        publish_mode: 'api',
        timezone: 'Asia/Shanghai',
        workspace_id: WORKSPACE_ID,
      },
      { requestId: 'req-lieju-retry-account' },
    );
    const policy = await policies.update(
      SCOPE,
      account.id,
      {
        daily_candidate_limit: 3,
        daily_enabled: true,
        daily_generation_time: '00:30:00',
        daily_schedule_times: ['10:00:00'],
        daily_target_count: 1,
        enabled: true,
        project_id: PROJECT_ID,
      },
      { requestId: 'req-lieju-retry-policy' },
    );
    await database`
      INSERT INTO browser_platform_daily_batches(
        tenant_id,policy_id,business_date,status,last_error_json
      ) VALUES(
        ${TENANT_ID}::uuid,${policy.id}::uuid,
        (now() AT TIME ZONE 'Asia/Shanghai')::date,'attention_required',
        '{"code":"AUTOMATION_PREREQUISITE_MISSING","message":"项目没有适用于 lieju 的关键词。"}'::jsonb
      )
    `;

    expect((await policies.list(SCOPE, account.id))[0]?.today_batch).toMatchObject({
      attempted_count: 0,
      retry_allowed: true,
      status: 'attention_required',
      version: 1,
    });
    const retried = await database.begin((transaction) =>
      policies.retryDailyBatchInTransaction(
        transaction,
        SCOPE,
        account.id,
        { expected_batch_version: 1, project_id: PROJECT_ID },
        { requestId: 'req-lieju-daily-retry' },
      ),
    );
    expect(retried.today_batch).toMatchObject({
      attempted_count: 0,
      last_error_message: null,
      retry_allowed: false,
      status: 'running',
      version: 2,
    });
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM audit_events
        WHERE tenant_id=${TENANT_ID}::uuid
          AND action='browser_platform.daily_batch.retried'
      `,
    ).toEqual([{ count: 1 }]);
    await expect(
      database.begin((transaction) =>
        policies.retryDailyBatchInTransaction(
          transaction,
          SCOPE,
          account.id,
          { expected_batch_version: 1, project_id: PROJECT_ID },
          { requestId: 'req-lieju-daily-retry-again' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'PLATFORM_ACCOUNT_VERSION_CONFLICT' });
  });

  it('starts a new browser-platform attempt without rewriting the exhausted batch', async () => {
    const database = requireClient(client);
    const accounts = new PlatformAccountService(
      database,
      new CredentialEnvelopeService(requireKms(kms)),
      new PlatformDeliveryAccountConnector(),
    );
    const policies = new BrowserPlatformAutomationPolicyService(database);
    const account = await accounts.create(
      SCOPE,
      {
        credential: {
          api_key: 'lieju-restart-test-api-key',
          delivery_method: 'official_api',
          posting_profile: {
            contact_name: '测试搬家服务公司',
            mobile_phone: '02000000000',
            qq: '',
            wechat: '',
            zone_id: '76',
          },
        },
        display_name: '列举网每日批次恢复测试',
        platform_code: 'lieju',
        publish_mode: 'api',
        timezone: 'Asia/Shanghai',
        workspace_id: WORKSPACE_ID,
      },
      { requestId: 'req-lieju-restart-account' },
    );
    const policy = await policies.update(
      SCOPE,
      account.id,
      {
        daily_candidate_limit: 3,
        daily_enabled: true,
        daily_generation_time: '00:30:00',
        daily_schedule_times: ['10:00:00'],
        daily_target_count: 1,
        enabled: true,
        project_id: PROJECT_ID,
      },
      { requestId: 'req-lieju-restart-policy' },
    );
    await database`
      INSERT INTO browser_platform_daily_batches(
        tenant_id,policy_id,business_date,status,last_error_json
      ) VALUES(
        ${TENANT_ID}::uuid,${policy.id}::uuid,
        (now() AT TIME ZONE 'Asia/Shanghai')::date,'attention_required',
        '{"code":"DAILY_CANDIDATE_LIMIT_REACHED","message":"候选上限已耗尽。"}'::jsonb
      )
    `;

    expect((await policies.list(SCOPE, account.id))[0]?.today_batch).toMatchObject({
      attempt_no: 1,
      restart_allowed: true,
      status: 'attention_required',
      version: 1,
    });
    const restarted = await database.begin((transaction) =>
      policies.restartDailyBatchInTransaction(
        transaction,
        SCOPE,
        account.id,
        { expected_batch_version: 1, project_id: PROJECT_ID },
        { requestId: 'req-lieju-daily-restart' },
      ),
    );

    expect(restarted.today_batch).toMatchObject({
      attempt_no: 2,
      attempted_count: 0,
      restart_allowed: false,
      status: 'running',
      version: 1,
    });
    expect(
      await database<{ attemptNo: number; status: string }[]>`
        SELECT attempt_no AS "attemptNo",status
        FROM browser_platform_daily_batches
        WHERE tenant_id=${TENANT_ID}::uuid AND policy_id=${policy.id}::uuid
        ORDER BY attempt_no
      `,
    ).toEqual([
      { attemptNo: 1, status: 'cancelled' },
      { attemptNo: 2, status: 'running' },
    ]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM audit_events
        WHERE tenant_id=${TENANT_ID}::uuid
          AND action='browser_platform.daily_batch.restarted'
      `,
    ).toEqual([{ count: 1 }]);
  });

  it('reattaches a manual browser-platform item before a user-requested quality check', async () => {
    const database = requireClient(client);
    const accounts = new PlatformAccountService(
      database,
      new CredentialEnvelopeService(requireKms(kms)),
      new PlatformDeliveryAccountConnector(),
    );
    const policies = new BrowserPlatformAutomationPolicyService(database);
    const account = await accounts.create(
      SCOPE,
      {
        credential: {
          api_key: 'lieju-manual-recheck-api-key',
          delivery_method: 'official_api',
          posting_profile: {
            contact_name: '测试搬家服务公司',
            mobile_phone: '02000000000',
            qq: '',
            wechat: '',
            zone_id: '76',
          },
        },
        display_name: '列举网人工重检测试',
        platform_code: 'lieju',
        publish_mode: 'api',
        timezone: 'Asia/Shanghai',
        workspace_id: WORKSPACE_ID,
      },
      { requestId: 'req-lieju-manual-recheck-account' },
    );
    const policy = await policies.update(
      SCOPE,
      account.id,
      {
        daily_candidate_limit: 3,
        daily_enabled: true,
        daily_generation_time: '00:30:00',
        daily_schedule_times: ['10:00:00'],
        daily_target_count: 1,
        enabled: true,
        project_id: PROJECT_ID,
      },
      { requestId: 'req-lieju-manual-recheck-policy' },
    );
    const briefId = '52000000-0000-4000-8000-000000000123';
    const packageId = '62000000-0000-4000-8000-000000000123';
    const variantId = '72000000-0000-4000-8000-000000000123';
    const versionId = '82000000-0000-4000-8000-000000000123';
    const automationRunId = 'a2000000-0000-4000-8000-000000000123';
    const contentHash = 'c'.repeat(64);
    await database`
      INSERT INTO briefs (
        id,tenant_id,workspace_id,project_id,title,objective,audience,
        platform_codes,constraints_json,created_by
      ) VALUES (
        ${briefId}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
        '列举网人工重检候选','awareness',
        '准备在列举网了解广州搬家服务流程和注意事项的潜在客户',ARRAY['lieju']::varchar[],
        '{"schema_version":"brief-constraints@1"}'::jsonb,${USER_ID}::uuid
      )
    `;
    await database`
      INSERT INTO content_packages (
        id,tenant_id,workspace_id,project_id,brief_id,status,created_by
      ) VALUES (
        ${packageId}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
        ${briefId}::uuid,'generated',${USER_ID}::uuid
      )
    `;
    await database`
      INSERT INTO content_variants (
        id,tenant_id,package_id,platform_code,platform_account_id,status
      ) VALUES (
        ${variantId}::uuid,${TENANT_ID}::uuid,${packageId}::uuid,'lieju',${account.id}::uuid,
        'generated'
      )
    `;
    await database`
      INSERT INTO content_versions (
        id,tenant_id,package_id,variant_id,version_no,schema_version,
        content_json,content_hash,created_by
      ) VALUES (
        ${versionId}::uuid,${TENANT_ID}::uuid,${packageId}::uuid,${variantId}::uuid,1,
        'content-document@1',
        ${database.json({
          blocks: [{ block_key: 'intro', text: '搬家前应确认服务范围。' }],
          platform_code: 'lieju',
          platform_meta: { content_type: 'logistics_freight' },
          schema_version: 'content-document@1',
          summary: '搬家服务准备说明',
          title: '厂房搬迁怎么选服务',
        })},${contentHash},${USER_ID}::uuid
      )
    `;
    await database`
      UPDATE content_variants SET current_content_version_id=${versionId}::uuid
      WHERE id=${variantId}::uuid AND tenant_id=${TENANT_ID}::uuid
    `;
    const batches = await database<{ id: string }[]>`
      INSERT INTO browser_platform_daily_batches (
        tenant_id,policy_id,business_date,status,last_error_json
      ) VALUES (
        ${TENANT_ID}::uuid,${policy.id}::uuid,
        (now() AT TIME ZONE 'Asia/Shanghai')::date,'attention_required',
        '{"code":"DAILY_CANDIDATE_LIMIT_REACHED","message":"候选需要人工处理。"}'::jsonb
      ) RETURNING id
    `;
    const batchId = batches[0]?.id;
    if (!batchId) throw new Error('Browser platform batch was not inserted');
    await database`
      INSERT INTO browser_platform_automation_runs (
        id,tenant_id,policy_id,platform_code,variant_id,content_version_id,status,
        rewrite_count,last_error_json,finished_at
      ) VALUES (
        ${automationRunId}::uuid,${TENANT_ID}::uuid,${policy.id}::uuid,'lieju',
        ${variantId}::uuid,${versionId}::uuid,'manual_required',3,
        '{"code":"QUALITY_CHECK_EXECUTION_FAILED"}'::jsonb,now()
      )
    `;
    await database`
      INSERT INTO browser_platform_daily_batch_items (
        tenant_id,batch_id,candidate_no,automation_run_id,brief_id,package_id,variant_id,
        content_version_id,status,last_error_json
      ) VALUES (
        ${TENANT_ID}::uuid,${batchId}::uuid,1,${automationRunId}::uuid,${briefId}::uuid,
        ${packageId}::uuid,${variantId}::uuid,${versionId}::uuid,'manual_required',
        '{"code":"QUALITY_CHECK_EXECUTION_FAILED"}'::jsonb
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
    process.env['QUALITY_CHECKER_MODEL_KEY'] = 'deepseek-v4-flash';
    process.env['QUALITY_CHECKER_PROMPT_VERSION_ID'] = QUALITY_PROMPT_ID;
    process.env['QUALITY_CHECKER_SKILL_VERSION'] = '1.0.0';
    try {
      await database.begin((transaction) =>
        service.requestQualityCheck(transaction, TENANT_ID, USER_ID, variantId, contentHash, {
          requestId: 'req-lieju-manual-recheck',
        }),
      );
    } finally {
      restoreEnvironment('QUALITY_CHECKER_MODEL_KEY', previousEnvironment.model);
      restoreEnvironment('QUALITY_CHECKER_PROMPT_VERSION_ID', previousEnvironment.prompt);
      restoreEnvironment('QUALITY_CHECKER_SKILL_VERSION', previousEnvironment.version);
    }

    expect(
      await database<
        {
          batchStatus: string;
          errorCode: string | null;
          finished: boolean;
          itemStatus: string;
          rewriteCount: number;
          runStatus: string;
        }[]
      >`
        SELECT batch.status AS "batchStatus",item.status AS "itemStatus",
          automation.status AS "runStatus",automation.rewrite_count AS "rewriteCount",
          automation.finished_at IS NOT NULL AS finished,
          automation.last_error_json->>'code' AS "errorCode"
        FROM browser_platform_automation_runs AS automation
        JOIN browser_platform_daily_batch_items AS item
          ON item.automation_run_id=automation.id AND item.tenant_id=automation.tenant_id
        JOIN browser_platform_daily_batches AS batch
          ON batch.id=item.batch_id AND batch.tenant_id=item.tenant_id
        WHERE automation.id=${automationRunId}::uuid
      `,
    ).toEqual([
      {
        batchStatus: 'running',
        errorCode: null,
        finished: false,
        itemStatus: 'quality_check',
        rewriteCount: 0,
        runStatus: 'quality_pending',
      },
    ]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM outbox_events
        WHERE tenant_id=${TENANT_ID}::uuid
          AND event_type='content.variant.quality_check_requested.v1'
          AND aggregate_id=${variantId}::uuid
      `,
    ).toEqual([{ count: 1 }]);
  });

  it('configures one fixed official-site automation policy per project and disables it with the account', async () => {
    const database = requireClient(client);
    const accounts = createService(database, requireKms(kms));
    const policies = new OfficialSiteAutomationPolicyService(database);
    const account = await accounts.create(
      SCOPE,
      {
        credential: { access_token: SECRET },
        display_name: 'Automatic Official Site',
        platform_code: 'official_site',
        publish_mode: 'api',
        timezone: 'Asia/Shanghai',
        workspace_id: WORKSPACE_ID,
      },
      { requestId: 'req-automation-account' },
    );

    const created = await policies.update(
      SCOPE,
      account.id,
      { daily_enabled: true, enabled: true, project_id: PROJECT_ID },
      { requestId: 'req-automation-enable' },
    );
    expect(created).toMatchObject({
      account_id: account.id,
      enabled: true,
      geo_total_min: 85,
      factual_accuracy_min: 90,
      brand_consistency_min: 90,
      daily_candidate_limit: 30,
      daily_enabled: true,
      daily_generation_time: '00:00:00',
      daily_schedule_times: [
        '08:00:00',
        '09:30:00',
        '11:00:00',
        '12:30:00',
        '14:00:00',
        '15:30:00',
        '17:00:00',
        '18:30:00',
        '20:00:00',
        '21:30:00',
      ],
      daily_target_count: 10,
      daily_timezone: 'Asia/Shanghai',
      readability_safety_min: 85,
      question_coverage_min: 80,
      platform_fit_min: 80,
      max_rewrites: 3,
      publish_attempt_limit: 3,
      project_id: PROJECT_ID,
      today_batch: null,
      version: 1,
    });
    await expect(policies.list(SCOPE, account.id)).resolves.toEqual([created]);
    await database`
      INSERT INTO official_site_daily_batches(
        tenant_id,policy_id,business_date,status,last_error_json
      ) VALUES(
        ${TENANT_ID}::uuid,${created.id}::uuid,
        (now() AT TIME ZONE 'Asia/Shanghai')::date,'attention_required',
        '{"code":"DAILY_CANDIDATE_LIMIT_REACHED","message":"已尝试 30 篇，仍未补足 10 篇合格内容。"}'::jsonb
      )
    `;
    const failedBatch = (await policies.list(SCOPE, account.id))[0]?.today_batch;
    expect(failedBatch).toMatchObject({
      attempt_no: 1,
      restart_allowed: true,
      status: 'attention_required',
      version: 1,
    });
    const restarted = await database.begin((transaction) =>
      policies.restartDailyBatchInTransaction(
        transaction,
        SCOPE,
        account.id,
        {
          expected_batch_version: 1,
          project_id: PROJECT_ID,
        },
        { requestId: 'req-daily-restart' },
      ),
    );
    expect(restarted.today_batch).toMatchObject({
      attempt_no: 2,
      attempted_count: 0,
      restart_allowed: false,
      status: 'running',
      version: 1,
    });
    expect(
      await database<{ attemptNo: number; status: string }[]>`
        SELECT attempt_no AS "attemptNo",status
        FROM official_site_daily_batches
        WHERE tenant_id=${TENANT_ID}::uuid AND policy_id=${created.id}::uuid
        ORDER BY attempt_no
      `,
    ).toEqual([
      { attemptNo: 1, status: 'cancelled' },
      { attemptNo: 2, status: 'running' },
    ]);
    await database`
      INSERT INTO briefs (
        id,tenant_id,workspace_id,project_id,title,objective,audience,
        platform_codes,constraints_json,created_by
      ) VALUES (
        ${DAILY_BRIEF_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,
        ${PROJECT_ID}::uuid,'待终止的每日候选','awareness',
        '准备在企业官网了解搬家服务的潜在客户',
        ARRAY['official_site']::varchar[],
        '{"schema_version":"brief-constraints@1"}'::jsonb,${USER_ID}::uuid
      )
    `;
    await database`
      INSERT INTO content_packages (
        id,tenant_id,workspace_id,project_id,brief_id,status,created_by
      ) VALUES (
        ${DAILY_PACKAGE_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,
        ${PROJECT_ID}::uuid,${DAILY_BRIEF_ID}::uuid,'generating',${USER_ID}::uuid
      )
    `;
    await database`
      INSERT INTO content_variants (
        id,tenant_id,package_id,platform_code,status
      ) VALUES (
        ${DAILY_VARIANT_ID}::uuid,${TENANT_ID}::uuid,${DAILY_PACKAGE_ID}::uuid,
        'official_site','generating'
      )
    `;
    await database`
      INSERT INTO official_site_daily_batch_items (
        tenant_id,batch_id,candidate_no,angle_key,title,brief_id,package_id,variant_id,status
      )
      SELECT
        ${TENANT_ID}::uuid,batch.id,1,'manual-cancel-test','待终止的每日候选',
        ${DAILY_BRIEF_ID}::uuid,${DAILY_PACKAGE_ID}::uuid,${DAILY_VARIANT_ID}::uuid,
        'generating'
      FROM official_site_daily_batches AS batch
      WHERE batch.tenant_id=${TENANT_ID}::uuid AND batch.policy_id=${created.id}::uuid
        AND batch.attempt_no=2
    `;
    expect((await policies.list(SCOPE, account.id))[0]?.today_batch).toMatchObject({
      in_progress_count: 1,
      queued_count: 1,
      running_count: 0,
      status: 'running',
    });
    await database`
      INSERT INTO generation_runs (
        tenant_id,workspace_id,project_id,package_id,variant_id,
        skill_name,skill_version,prompt_version_id,model_key,input_hash,request_id,
        status,started_at
      ) VALUES (
        ${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
        ${DAILY_PACKAGE_ID}::uuid,${DAILY_VARIANT_ID}::uuid,
        'content-writer','1.0.0',${WRITER_PROMPT_ID}::uuid,'deepseek-v4-pro',
        ${'a'.repeat(64)},'daily-progress-running','running',now()
      )
    `;
    expect((await policies.list(SCOPE, account.id))[0]?.today_batch).toMatchObject({
      in_progress_count: 1,
      queued_count: 0,
      running_count: 1,
      status: 'running',
    });
    const cancelled = await database.begin((transaction) =>
      policies.cancelDailyBatchInTransaction(
        transaction,
        SCOPE,
        account.id,
        {
          expected_batch_version: 1,
          project_id: PROJECT_ID,
        },
        { requestId: 'req-daily-cancel' },
      ),
    );
    expect(cancelled.today_batch).toMatchObject({
      attempt_no: 2,
      in_progress_count: 0,
      queued_count: 0,
      restart_allowed: true,
      running_count: 0,
      status: 'cancelled',
      version: 2,
    });
    await expect(
      database<{ status: string }[]>`
        SELECT status FROM official_site_daily_batch_items
        WHERE tenant_id=${TENANT_ID}::uuid AND variant_id=${DAILY_VARIANT_ID}::uuid
      `,
    ).resolves.toEqual([{ status: 'retired' }]);
    await expect(
      database<{ status: string }[]>`
        SELECT status FROM content_variants
        WHERE tenant_id=${TENANT_ID}::uuid AND id=${DAILY_VARIANT_ID}::uuid
      `,
    ).resolves.toEqual([{ status: 'generation_failed' }]);
    await expect(
      database<{ status: string }[]>`
        SELECT status FROM content_packages
        WHERE tenant_id=${TENANT_ID}::uuid AND id=${DAILY_PACKAGE_ID}::uuid
      `,
    ).resolves.toEqual([{ status: 'all_failed' }]);
    await expect(
      database.begin((transaction) =>
        policies.cancelDailyBatchInTransaction(
          transaction,
          SCOPE,
          account.id,
          {
            expected_batch_version: 1,
            project_id: PROJECT_ID,
          },
          { requestId: 'req-daily-cancel-stale' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'PLATFORM_ACCOUNT_VERSION_CONFLICT' });
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM audit_events
        WHERE tenant_id=${TENANT_ID}::uuid
          AND action='official_site.daily_batch.restarted'
      `,
    ).toEqual([{ count: 1 }]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM audit_events
        WHERE tenant_id=${TENANT_ID}::uuid
          AND action='official_site.daily_batch.cancelled'
      `,
    ).toEqual([{ count: 1 }]);
    const restartedAfterCancel = await database.begin((transaction) =>
      policies.restartDailyBatchInTransaction(
        transaction,
        SCOPE,
        account.id,
        {
          expected_batch_version: 2,
          project_id: PROJECT_ID,
        },
        { requestId: 'req-daily-restart-after-cancel' },
      ),
    );
    expect(restartedAfterCancel.today_batch).toMatchObject({
      attempt_no: 3,
      restart_allowed: false,
      status: 'running',
      version: 1,
    });
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM official_site_daily_batches
        WHERE tenant_id=${TENANT_ID}::uuid AND policy_id=${created.id}::uuid
      `,
    ).toEqual([{ count: 3 }]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM audit_events
        WHERE tenant_id=${TENANT_ID}::uuid
          AND action='official_site.daily_batch.restarted'
      `,
    ).toEqual([{ count: 2 }]);
    await expect(
      policies.update(
        SCOPE,
        account.id,
        { enabled: false, expected_version: 2, project_id: PROJECT_ID },
        { requestId: 'req-automation-stale' },
      ),
    ).rejects.toMatchObject({ code: 'PLATFORM_ACCOUNT_VERSION_CONFLICT' });

    await accounts.disable(SCOPE, account.id, 'maintenance', account.version, {
      requestId: 'req-automation-account-disable',
    });
    expect(await policies.list(SCOPE, account.id)).toEqual([
      expect.objectContaining({ daily_enabled: false, enabled: false }),
    ]);
  });
});

function createService(database: Sql, localKms: LocalCredentialKms): PlatformAccountService {
  const connector: PlatformAccountConnector = {
    async probe(input) {
      expect(input.credential).not.toBeNull();
      return {
        capabilities: { publish: true },
        providerAccountId: `${input.platformCode}-account`,
        publishMode: input.publishMode,
        scopes: ['content.publish'],
        status: 'active',
        tokenExpiresAt: new Date('2027-01-01T00:00:00.000Z'),
      };
    },
    async refresh(input) {
      expect(input.credential).toEqual({ access_token: SECRET });
      return {
        capabilities: { publish: true },
        providerAccountId: `${input.platformCode}-account`,
        publishMode: 'api',
        scopes: ['content.publish'],
        status: 'active',
        tokenExpiresAt: new Date('2027-06-01T00:00:00.000Z'),
      };
    },
  };
  return new PlatformAccountService(database, new CredentialEnvelopeService(localKms), connector);
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id,email,display_name,status) VALUES
      (${USER_ID}::uuid,'publisher-123@example.com','Publisher','active'),
      (${OTHER_USER_ID}::uuid,'other-publisher-123@example.com','Other Publisher','active')
  `;
  await database`
    INSERT INTO tenants (id,name,slug,status)
    VALUES (${TENANT_ID}::uuid,'Account Tenant','account-tenant-123','active')
  `;
  await database`
    INSERT INTO memberships (tenant_id,user_id,role_code,status) VALUES
      (${TENANT_ID}::uuid,${USER_ID}::uuid,'publisher','active'),
      (${TENANT_ID}::uuid,${OTHER_USER_ID}::uuid,'publisher','active')
  `;
  await database`
    INSERT INTO workspaces (id,tenant_id,name,slug,timezone,status) VALUES
      (${WORKSPACE_ID}::uuid,${TENANT_ID}::uuid,'Account Workspace','account-workspace','Asia/Shanghai','active'),
      (${OTHER_WORKSPACE_ID}::uuid,${TENANT_ID}::uuid,'Other Workspace','other-account-workspace','Asia/Shanghai','active')
  `;
  await database`
    INSERT INTO workspace_memberships (workspace_id,user_id,scope_json) VALUES
      (${WORKSPACE_ID}::uuid,${USER_ID}::uuid,'{}'::jsonb),
      (${OTHER_WORKSPACE_ID}::uuid,${OTHER_USER_ID}::uuid,'{}'::jsonb)
  `;
  await database`
    INSERT INTO projects (id,tenant_id,workspace_id,name,owner_id,status)
    VALUES (${PROJECT_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,'Automation Project',${USER_ID}::uuid,'active')
  `;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('PostgreSQL client is not initialized');
  return client;
}

function requireKms(kms: LocalCredentialKms | undefined): LocalCredentialKms {
  if (!kms) throw new Error('Local KMS is not initialized');
  return kms;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
