import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import { readdir, readFile } from 'node:fs/promises';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresBaijiahaoBrowserStore } from './store.js';
import type { BrowserPublishInput } from './types.js';

const USER_ID = '10000000-0000-4000-8000-000000000145';
const TENANT_ID = '20000000-0000-4000-8000-000000000145';
const WORKSPACE_ID = '30000000-0000-4000-8000-000000000145';
const PROJECT_ID = '40000000-0000-4000-8000-000000000145';
const BRIEF_ID = '50000000-0000-4000-8000-000000000145';
const PACKAGE_ID = '60000000-0000-4000-8000-000000000145';
const VARIANT_ID = '70000000-0000-4000-8000-000000000145';
const VERSION_ID = '80000000-0000-4000-8000-000000000145';
const ACCOUNT_ID = '90000000-0000-4000-8000-000000000145';
const JOB_ID = 'a0000000-0000-4000-8000-000000000145';
const COVER_ID = 'b0000000-0000-4000-8000-000000000145';
const UNVERIFIED_ID = 'c0000000-0000-4000-8000-000000000145';
const CONTENT_HASH = 'a'.repeat(64);
const COVER_HASH = 'b'.repeat(64);
const MIGRATIONS = new URL('../../../apps/api/src/database/migrations/', import.meta.url);

describe('Postgres Baijiahao browser store', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    client = postgres(container.getConnectionUri(), { max: 4 });
    await migrate(requireClient(client));
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`
      TRUNCATE
        baijiahao_browser_artifacts,baijiahao_browser_publications,baijiahao_browser_sessions,
        baijiahao_daily_batch_items,baijiahao_daily_batches,baijiahao_automation_runs,
        baijiahao_automation_policies,publish_attempts,publish_jobs,media_assets,
        platform_accounts,content_versions,content_variants,content_packages,briefs,
        workspace_memberships,projects,workspaces,memberships,tenants,users
      CASCADE
    `;
    await seed(database);
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('persists encrypted session state and enforces publication idempotency', async () => {
    const store = new PostgresBaijiahaoBrowserStore(requireClient(client));
    const session = await store.getOrCreateSession(ACCOUNT_ID);
    expect(session.profileKey).toBe(`baijiahao/${TENANT_ID}/${ACCOUNT_ID}`);
    const authenticated = await store.markSession(session, {
      authenticatedAt: new Date('2026-08-02T00:00:00.000Z'),
      lastVerifiedAt: new Date('2026-08-02T00:00:00.000Z'),
      status: 'authenticated',
      storageStateCiphertext: 'encrypted-state-not-a-cookie',
      storageStateKeyVersion: 'test-v1',
    });
    expect((await store.getSession(ACCOUNT_ID)).storageStateCiphertext).toBe(
      'encrypted-state-not-a-cookie',
    );

    const first = await store.preparePublication(ACCOUNT_ID, publishInput(), 'c'.repeat(64));
    const replay = await store.preparePublication(ACCOUNT_ID, publishInput(), 'c'.repeat(64));
    expect(replay.id).toBe(first.id);
    await expect(
      store.preparePublication(
        ACCOUNT_ID,
        { ...publishInput(), payloadHash: 'd'.repeat(64) },
        'c'.repeat(64),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const unknown = await store.updatePublication(first, {
      status: 'unknown',
      submittedAt: new Date('2026-08-02T00:01:00.000Z'),
    });
    expect((await store.findPublication(ACCOUNT_ID, unknown.id)).status).toBe('unknown');
    expect(authenticated.status).toBe('authenticated');
  });

  it('accepts a manual Baijiahao publish job for browser submission', async () => {
    const database = requireClient(client);
    await database`DELETE FROM publish_jobs WHERE id=${JOB_ID}::uuid`;
    await database`
      INSERT INTO publish_jobs(
        id,tenant_id,variant_id,content_version_id,account_id,scheduled_at,
        idempotency_key,payload_hash,status,origin,attempt_count,created_by
      ) VALUES(
        ${JOB_ID}::uuid,${TENANT_ID}::uuid,${VARIANT_ID}::uuid,${VERSION_ID}::uuid,
        ${ACCOUNT_ID}::uuid,now(),'baijiahao-t145-publication',${CONTENT_HASH},
        'publishing','manual',1,${USER_ID}::uuid
      )
    `;
    const store = new PostgresBaijiahaoBrowserStore(database);
    const session = await store.getOrCreateSession(ACCOUNT_ID);
    await store.markSession(session, { status: 'authenticated' });

    await expect(
      store.preparePublication(ACCOUNT_ID, publishInput(), 'c'.repeat(64)),
    ).resolves.toMatchObject({ publishJobId: JOB_ID, status: 'prepared' });
  });

  it('loads only version-scoped images with a verified no-watermark result', async () => {
    const store = new PostgresBaijiahaoBrowserStore(requireClient(client));
    const session = await store.getOrCreateSession(ACCOUNT_ID);
    await store.markSession(session, { status: 'authenticated' });
    const publication = await store.preparePublication(ACCOUNT_ID, publishInput(), 'c'.repeat(64));

    await expect(store.loadImageAssets(publication, COVER_ID, [])).resolves.toEqual([
      {
        assetId: COVER_ID,
        contentHash: COVER_HASH,
        mimeType: 'image/png',
        objectUri: 's3://test/baijiahao/cover.png',
        role: 'cover',
        sizeBytes: 145,
      },
    ]);
    await expect(store.loadImageAssets(publication, COVER_ID, [COVER_ID])).rejects.toMatchObject({
      code: 'STATE_INVALID',
    });
    await expect(store.loadImageAssets(publication, UNVERIFIED_ID, [])).rejects.toMatchObject({
      code: 'STATE_INVALID',
    });
  });
});

function publishInput(): BrowserPublishInput {
  return {
    contentVersionId: VERSION_ID,
    idempotencyKey: 'baijiahao-t145-publication',
    payload: {
      abstract: '这是用于浏览器存储集成测试的摘要。',
      body_asset_ids: [],
      body_html: '<p>百家号存储集成测试正文。</p>',
      body_text: '百家号存储集成测试正文。',
      citation_links: [],
      content_type: 'news',
      cover_asset_id: COVER_ID,
      platform_code: 'baijiahao',
      rule_version: 'baijiahao-render-rules@1.1.0',
      schema_version: 'baijiahao-payload@2',
      tags: ['搬家', '准备', '指南'],
      title: '百家号存储集成测试',
    },
    payloadHash: 'e'.repeat(64),
  };
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users(id,email,display_name,status)
    VALUES(${USER_ID}::uuid,'baijiahao-t145@example.com','T145','active')
  `;
  await database`
    INSERT INTO tenants(id,name,slug,status)
    VALUES(${TENANT_ID}::uuid,'T145 Tenant','t145-tenant','active')
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
    VALUES(${PROJECT_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,'T145',${USER_ID}::uuid,'active')
  `;
  await database`
    INSERT INTO briefs(
      id,tenant_id,workspace_id,project_id,title,objective,audience,
      platform_codes,constraints_json,created_by
    ) VALUES(
      ${BRIEF_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
      'T145 Brief','education','企业内容发布管理人员',ARRAY['baijiahao']::varchar[],
      '{"schema_version":"brief-constraints@1"}'::jsonb,${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO content_packages(
      id,tenant_id,workspace_id,project_id,brief_id,status,created_by
    ) VALUES(
      ${PACKAGE_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
      ${BRIEF_ID}::uuid,'publishing',${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO content_variants(id,tenant_id,package_id,platform_code,status)
    VALUES(${VARIANT_ID}::uuid,${TENANT_ID}::uuid,${PACKAGE_ID}::uuid,'baijiahao','publishing')
  `;
  await database`
    INSERT INTO content_versions(
      id,tenant_id,package_id,variant_id,version_no,schema_version,
      content_json,content_hash,created_by
    ) VALUES(
      ${VERSION_ID}::uuid,${TENANT_ID}::uuid,${PACKAGE_ID}::uuid,${VARIANT_ID}::uuid,
      1,'content-writer-data@1','{"schema_version":"content-writer-data@1"}'::jsonb,
      ${CONTENT_HASH},${USER_ID}::uuid
    )
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
      ${ACCOUNT_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,'baijiahao',
      't145-provider','T145 Baijiahao','{"publish":true}'::jsonb,'api','active','Asia/Shanghai'
    )
  `;
  await database`
    INSERT INTO publish_jobs(
      id,tenant_id,variant_id,content_version_id,account_id,scheduled_at,
      idempotency_key,payload_hash,status,origin,attempt_count,created_by
    ) VALUES(
      ${JOB_ID}::uuid,${TENANT_ID}::uuid,${VARIANT_ID}::uuid,${VERSION_ID}::uuid,
      ${ACCOUNT_ID}::uuid,now(),'baijiahao-t145-publication',${CONTENT_HASH},
      'publishing','baijiahao_automation',1,${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO media_assets(
      id,tenant_id,workspace_id,project_id,asset_type,object_uri,content_hash,
      mime_type,size_bytes,metadata_json,created_by
    ) VALUES
      (
        ${COVER_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
        'image','s3://test/baijiahao/cover.png',${COVER_HASH},'image/png',145,
        ${database.json({ content_version_id: VERSION_ID, promotional_watermark: 'false' })},
        ${USER_ID}::uuid
      ),
      (
        ${UNVERIFIED_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
        'image','s3://test/baijiahao/unverified.png',${'c'.repeat(64)},'image/png',145,
        ${database.json({ content_version_id: VERSION_ID, promotional_watermark: 'unknown' })},
        ${USER_ID}::uuid
      )
  `;
}

async function migrate(database: Sql): Promise<void> {
  const files = (await readdir(MIGRATIONS))
    .filter((name) => /^\d+.*\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right));
  for (const file of files) {
    const sql = await readFile(new URL(file, MIGRATIONS), 'utf8');
    await database.begin(async (transaction) => {
      for (const statement of sql.split('--> statement-breakpoint')) {
        if (statement.trim()) await transaction.unsafe(statement);
      }
    });
  }
}

function requireClient(value: Sql | undefined): Sql {
  if (!value) throw new Error('PostgreSQL client is not initialized');
  return value;
}
