import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import {
  PublishingRepository,
  type PublishingScope,
} from '../../src/modules/publishing/repositories/index.js';

const USER_ID = '11000000-0000-4000-8000-000000000121';
const OTHER_USER_ID = '11000000-0000-4000-8000-000000000221';
const TENANT_ID = '21000000-0000-4000-8000-000000000121';
const OTHER_TENANT_ID = '21000000-0000-4000-8000-000000000221';
const WORKSPACE_ID = '31000000-0000-4000-8000-000000000121';
const PROJECT_ID = '41000000-0000-4000-8000-000000000121';
const BRIEF_ID = '51000000-0000-4000-8000-000000000121';
const PACKAGE_ID = '61000000-0000-4000-8000-000000000121';
const VARIANT_ID = '71000000-0000-4000-8000-000000000121';
const VERSION_ID = '81000000-0000-4000-8000-000000000121';
const ACCOUNT_ID = '91000000-0000-4000-8000-000000000121';
const WRONG_ACCOUNT_ID = '91000000-0000-4000-8000-000000000221';
const ASSET_ID = 'a1000000-0000-4000-8000-000000000121';
const JOB_ID = 'b1000000-0000-4000-8000-000000000121';
const ATTEMPT_ID = 'c1000000-0000-4000-8000-000000000121';
const ARTIFACT_ID = 'd1000000-0000-4000-8000-000000000121';
const CONTENT_HASH = 'a'.repeat(64);
const PAYLOAD_HASH = 'b'.repeat(64);
const REQUEST_HASH = 'c'.repeat(64);

const SCOPE: PublishingScope = {
  tenantId: TENANT_ID,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
};

describe('publishing database', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 4 });
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`
      TRUNCATE
        export_artifacts, publish_attempts, publish_jobs, media_assets, platform_accounts,
        usage_ledger, ai_citations, content_block_locks, content_blocks, content_versions,
        content_variants, content_packages, fact_sources, facts, embeddings, source_chunks,
        ingest_jobs, brief_sources, brief_keywords, briefs, source_documents, topic_candidates,
        generation_runs, keywords, keyword_sets, brand_profiles, workspace_memberships,
        projects, workspaces, audit_events, outbox_events, support_access_grants,
        idempotency_records, password_reset_tokens, invitations, sessions, platform_roles,
        memberships, tenants, users
      CASCADE
    `;
    await seed(database);
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('installs all frozen publishing tables and required idempotency indexes', async () => {
    const database = requireClient(client);
    const tables = await database<{ name: string }[]>`
      SELECT tablename AS name
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN (
          'platform_accounts', 'media_assets', 'publish_jobs',
          'publish_attempts', 'export_artifacts'
        )
      ORDER BY tablename
    `;
    expect(tables.map((table) => table.name)).toEqual([
      'export_artifacts',
      'media_assets',
      'platform_accounts',
      'publish_attempts',
      'publish_jobs',
    ]);

    const indexes = await database<{ name: string }[]>`
      SELECT indexname AS name
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('publish_jobs_idempotency_uq', 'publish_attempts_job_attempt_uq')
      ORDER BY indexname
    `;
    expect(indexes.map((index) => index.name)).toEqual([
      'publish_attempts_job_attempt_uq',
      'publish_jobs_idempotency_uq',
    ]);
  });

  it('returns the scoped graph without ever selecting account credentials', async () => {
    const repository = new PublishingRepository(requireClient(client));
    const accounts = await repository.listAccounts(SCOPE);
    expect(accounts).toMatchObject([
      {
        id: ACCOUNT_ID,
        platformCode: 'official_site',
        status: 'active',
        workspaceId: WORKSPACE_ID,
      },
      {
        id: WRONG_ACCOUNT_ID,
        platformCode: 'zhihu',
        workspaceId: WORKSPACE_ID,
      },
    ]);
    expect(accounts[0]).not.toHaveProperty('credentialCiphertext');
    expect(accounts[0]).not.toHaveProperty('credentialKeyVersion');
    await expect(repository.findAccount(SCOPE, ACCOUNT_ID)).resolves.toMatchObject({
      id: ACCOUNT_ID,
    });
    await expect(repository.findMediaAsset(SCOPE, ASSET_ID)).resolves.toMatchObject({
      id: ASSET_ID,
      projectId: PROJECT_ID,
    });
    await expect(repository.findJob(SCOPE, JOB_ID)).resolves.toMatchObject({
      contentVersionId: VERSION_ID,
      id: JOB_ID,
      variantId: VARIANT_ID,
    });
    await expect(repository.listJobs(SCOPE)).resolves.toHaveLength(1);
    await expect(repository.listAttempts(SCOPE, JOB_ID)).resolves.toMatchObject([
      { id: ATTEMPT_ID, requestHash: REQUEST_HASH },
    ]);
    await expect(repository.listExportArtifacts(SCOPE, VARIANT_ID)).resolves.toMatchObject([
      { contentVersionId: VERSION_ID, id: ARTIFACT_ID, publishJobId: JOB_ID },
    ]);
  });

  it('hides records from a different tenant and user scope', async () => {
    const repository = new PublishingRepository(requireClient(client));
    const foreignScope: PublishingScope = {
      tenantId: OTHER_TENANT_ID,
      userId: OTHER_USER_ID,
      workspaceId: WORKSPACE_ID,
    };
    await expect(repository.listAccounts(foreignScope)).resolves.toEqual([]);
    await expect(repository.findMediaAsset(foreignScope, ASSET_ID)).resolves.toBeUndefined();
    await expect(repository.findJob(foreignScope, JOB_ID)).resolves.toBeUndefined();
    await expect(repository.listAttempts(foreignScope, JOB_ID)).resolves.toEqual([]);
    await expect(repository.listExportArtifacts(foreignScope, VARIANT_ID)).resolves.toEqual([]);
  });

  it('freezes publish scope and rejects account/platform or content-version mismatches', async () => {
    const database = requireClient(client);
    await expect(
      database`
        UPDATE publish_jobs
        SET payload_hash = ${'d'.repeat(64)}
        WHERE id = ${JOB_ID}::uuid
      `,
    ).rejects.toThrow(/frozen payload/u);
    await expect(
      database`
        INSERT INTO publish_jobs (
          tenant_id, variant_id, content_version_id, account_id, scheduled_at,
          idempotency_key, payload_hash, created_by
        ) VALUES (
          ${TENANT_ID}::uuid, ${VARIANT_ID}::uuid, ${VERSION_ID}::uuid,
          ${WRONG_ACCOUNT_ID}::uuid, now(), 'wrong-platform', ${PAYLOAD_HASH}, ${USER_ID}::uuid
        )
      `,
    ).rejects.toThrow(/must match the variant scope/u);
    await expect(
      database`
        INSERT INTO publish_jobs (
          tenant_id, variant_id, content_version_id, account_id, scheduled_at,
          idempotency_key, payload_hash, created_by
        ) VALUES (
          ${TENANT_ID}::uuid, ${VARIANT_ID}::uuid, ${VERSION_ID}::uuid,
          ${ACCOUNT_ID}::uuid, now(), 'publish-job-121', ${PAYLOAD_HASH}, ${USER_ID}::uuid
        )
      `,
    ).rejects.toThrow(/publish_jobs_idempotency_uq/u);
  });

  it('keeps attempts and export artifacts append-only', async () => {
    const database = requireClient(client);
    await expect(
      database`UPDATE publish_attempts SET status = 'failed' WHERE id = ${ATTEMPT_ID}::uuid`,
    ).rejects.toThrow(/append-only/u);
    await expect(
      database`DELETE FROM publish_attempts WHERE id = ${ATTEMPT_ID}::uuid`,
    ).rejects.toThrow(/append-only/u);
    await expect(
      database`UPDATE export_artifacts SET expires_at = now() WHERE id = ${ARTIFACT_ID}::uuid`,
    ).rejects.toThrow(/append-only/u);
    await expect(
      database`DELETE FROM export_artifacts WHERE id = ${ARTIFACT_ID}::uuid`,
    ).rejects.toThrow(/append-only/u);
  });
});

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id, email, display_name, status) VALUES
      (${USER_ID}::uuid, 'publisher@example.com', 'Publisher', 'active'),
      (${OTHER_USER_ID}::uuid, 'other@example.com', 'Other', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status) VALUES
      (${TENANT_ID}::uuid, 'Publishing Tenant', 'publishing-tenant', 'active'),
      (${OTHER_TENANT_ID}::uuid, 'Other Tenant', 'other-publishing-tenant', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status) VALUES
      (${TENANT_ID}::uuid, ${USER_ID}::uuid, 'publisher', 'active'),
      (${OTHER_TENANT_ID}::uuid, ${OTHER_USER_ID}::uuid, 'publisher', 'active')
  `;
  await database`
    INSERT INTO workspaces (id, tenant_id, name, slug, timezone, status)
    VALUES (${WORKSPACE_ID}::uuid, ${TENANT_ID}::uuid, 'Publishing Workspace', 'publishing', 'Asia/Shanghai', 'active')
  `;
  await database`
    INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id, status)
    VALUES (${PROJECT_ID}::uuid, ${TENANT_ID}::uuid, ${WORKSPACE_ID}::uuid, 'Publishing Project', ${USER_ID}::uuid, 'active')
  `;
  await database`
    INSERT INTO briefs (
      id, tenant_id, workspace_id, project_id, title, objective, audience,
      platform_codes, constraints_json, created_by
    ) VALUES (
      ${BRIEF_ID}::uuid, ${TENANT_ID}::uuid, ${WORKSPACE_ID}::uuid, ${PROJECT_ID}::uuid,
      'Publishing Brief', 'awareness', 'Enterprise content publishing audience',
      ARRAY['official_site']::varchar[],
      ${database.json({ schema_version: 'brief-constraints@1' })},
      ${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO content_packages (
      id, tenant_id, workspace_id, project_id, brief_id, status, created_by
    ) VALUES (
      ${PACKAGE_ID}::uuid, ${TENANT_ID}::uuid, ${WORKSPACE_ID}::uuid,
      ${PROJECT_ID}::uuid, ${BRIEF_ID}::uuid, 'approved', ${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO content_variants (id, tenant_id, package_id, platform_code, status)
    VALUES (${VARIANT_ID}::uuid, ${TENANT_ID}::uuid, ${PACKAGE_ID}::uuid, 'official_site', 'approved')
  `;
  await database`
    INSERT INTO content_versions (
      id, tenant_id, package_id, variant_id, version_no, schema_version,
      content_json, content_hash, created_by
    ) VALUES (
      ${VERSION_ID}::uuid, ${TENANT_ID}::uuid, ${PACKAGE_ID}::uuid, ${VARIANT_ID}::uuid,
      1, 'content-document@1',
      ${database.json({ schema_version: 'content-document@1', title: 'Frozen content' })},
      ${CONTENT_HASH}, ${USER_ID}::uuid
    )
  `;
  await database`
    UPDATE content_variants
    SET current_content_version_id = ${VERSION_ID}::uuid
    WHERE id = ${VARIANT_ID}::uuid
  `;
  await database`
    INSERT INTO platform_accounts (
      id, tenant_id, workspace_id, platform_code, provider_account_id, display_name,
      credential_ciphertext, credential_key_version, scopes, capabilities_json,
      publish_mode, status, timezone
    ) VALUES
      (
        ${ACCOUNT_ID}::uuid, ${TENANT_ID}::uuid, ${WORKSPACE_ID}::uuid,
        'official_site', 'site-121', 'Official Site', 'encrypted-secret', 'local-v1',
        ARRAY['publish'], ${database.json({ schema_version: 'adapter-capability@1', publish: true })},
        'api', 'active', 'Asia/Shanghai'
      ),
      (
        ${WRONG_ACCOUNT_ID}::uuid, ${TENANT_ID}::uuid, ${WORKSPACE_ID}::uuid,
        'zhihu', 'zhihu-121', 'Zhihu', NULL, NULL,
        ARRAY[]::text[], ${database.json({})}, 'export', 'active', 'Asia/Shanghai'
      )
  `;
  await database`
    INSERT INTO media_assets (
      id, tenant_id, workspace_id, project_id, asset_type, object_uri,
      content_hash, mime_type, size_bytes, metadata_json, created_by
    ) VALUES (
      ${ASSET_ID}::uuid, ${TENANT_ID}::uuid, ${WORKSPACE_ID}::uuid, ${PROJECT_ID}::uuid,
      'image', 's3://publishing/media/cover.png', ${CONTENT_HASH}, 'image/png', 2048,
      ${database.json({ schema_version: 'media-metadata@1', width: 1200 })}, ${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO publish_jobs (
      id, tenant_id, variant_id, content_version_id, account_id, scheduled_at,
      idempotency_key, payload_hash, status, attempt_count, created_by
    ) VALUES (
      ${JOB_ID}::uuid, ${TENANT_ID}::uuid, ${VARIANT_ID}::uuid, ${VERSION_ID}::uuid,
      ${ACCOUNT_ID}::uuid, now() + interval '1 hour', 'publish-job-121', ${PAYLOAD_HASH},
      'scheduled', 1, ${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO publish_attempts (
      id, tenant_id, publish_job_id, attempt_no, adapter_code, status,
      request_hash, response_json, started_at, finished_at
    ) VALUES (
      ${ATTEMPT_ID}::uuid, ${TENANT_ID}::uuid, ${JOB_ID}::uuid, 1,
      'official-site-adapter', 'succeeded', ${REQUEST_HASH},
      ${database.json({ external_post_id: 'post-121' })}, now() - interval '2 minutes', now()
    )
  `;
  await database`
    INSERT INTO export_artifacts (
      id, tenant_id, variant_id, content_version_id, publish_job_id, object_uri,
      manifest_json, content_hash, expires_at, created_by
    ) VALUES (
      ${ARTIFACT_ID}::uuid, ${TENANT_ID}::uuid, ${VARIANT_ID}::uuid, ${VERSION_ID}::uuid,
      ${JOB_ID}::uuid, 's3://publishing/exports/content.zip',
      ${database.json({ schema_version: 'export-manifest@1', files: ['content.html'] })},
      ${CONTENT_HASH}, now() + interval '1 day', ${USER_ID}::uuid
    )
  `;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('PostgreSQL test client is not initialized');
  return client;
}
