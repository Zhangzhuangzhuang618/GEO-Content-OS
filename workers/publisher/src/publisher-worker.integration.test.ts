import { InMemoryStorageAdapter, type ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import {
  CredentialEnvelopeService,
  LocalCredentialKms,
} from '@geo-content-os/security/credentials';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresPublisherStore } from './publisher.store.js';
import type { PlatformDelivery, PublishClaim, PublisherPlatformPort } from './publisher.types.js';
import { PublisherWorker } from './publisher.worker.js';

const USER_ID = '11000000-0000-4000-8000-000000000125';
const TENANT_ID = '21000000-0000-4000-8000-000000000125';
const WORKSPACE_ID = '31000000-0000-4000-8000-000000000125';
const PROJECT_ID = '41000000-0000-4000-8000-000000000125';
const BRIEF_ID = '51000000-0000-4000-8000-000000000125';
const PACKAGE_ID = '61000000-0000-4000-8000-000000000125';
const VARIANT_ID = '71000000-0000-4000-8000-000000000125';
const VERSION_ID = '81000000-0000-4000-8000-000000000125';
const ACCOUNT_ID = '91000000-0000-4000-8000-000000000125';
const JOB_ID = 'a1000000-0000-4000-8000-000000000125';
const POLICY_ID = 'a2000000-0000-4000-8000-000000000125';
const AUTOMATION_RUN_ID = 'a3000000-0000-4000-8000-000000000125';
const CONTENT_HASH = 'a'.repeat(64);
const PLATFORM_PAYLOAD_HASH = 'b'.repeat(64);
const ACCESS_TOKEN = 't125-platform-secret';
const MIGRATIONS = new URL('../../../apps/api/src/database/migrations/', import.meta.url);

describe('publisher worker', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  let credentials: CredentialEnvelopeService | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    client = postgres(container.getConnectionUri(), { max: 4 });
    await migrate(requireClient(client));
    credentials = new CredentialEnvelopeService(
      new LocalCredentialKms('test-v1', { 'test-v1': randomBytes(32) }),
    );
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`
      TRUNCATE
        export_artifacts, publish_attempts, publish_jobs, media_assets, platform_accounts,
        content_versions, content_variants, content_packages, briefs, workspace_memberships,
        projects, workspaces, audit_events, outbox_events, memberships, tenants, users
      CASCADE
    `;
    await seed(database, requireCredentials(credentials));
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('publishes once with a stable external idempotency key and immutable attempt', async () => {
    const database = requireClient(client);
    const platform = new FakePlatform({
      externalId: 'external-t125',
      mode: 'api',
      payloadHash: PLATFORM_PAYLOAD_HASH,
      response: { status: 'published' },
      url: 'https://example.com/posts/external-t125',
    });
    const worker = createWorker(database, requireCredentials(credentials), platform);

    await expect(worker.run(event())).resolves.toMatchObject({
      attempt: 1,
      disposition: 'processed',
      mode: 'api',
    });
    await expect(worker.run(event())).resolves.toMatchObject({ disposition: 'completed' });

    expect(platform.claims).toHaveLength(1);
    expect(platform.claims[0]?.idempotencyKey).toBe('publish-job-125-stable');
    expect(platform.credentials[0]).toEqual({ access_token: ACCESS_TOKEN });
    await expect(state(database)).resolves.toMatchObject({
      attemptCount: 1,
      attemptStatus: ['succeeded'],
      jobStatus: 'published',
      packageStatus: 'published',
      variantStatus: 'published',
    });
    await expect(
      database`UPDATE publish_attempts SET status='failed' WHERE publish_job_id=${JOB_ID}::uuid`,
    ).rejects.toThrow(/append-only/u);
    const audit = await database<{ value: string }[]>`
      SELECT COALESCE(string_agg(after_json::text, ''), '') AS value
      FROM audit_events WHERE resource_id=${JOB_ID}::uuid
    `;
    expect(audit[0]?.value).not.toContain(ACCESS_TOKEN);
  });

  it('retries an idempotent official-site unknown state twice and stops after attempt three', async () => {
    const database = requireClient(client);
    await enableAutomation(database);
    const platform = new FakePlatform(undefined, 'PUBLISH_STATE_UNKNOWN');
    const worker = createWorker(database, requireCredentials(credentials), platform);

    await expect(worker.run(event())).rejects.toMatchObject({ retryable: true });
    await expect(worker.run(event())).rejects.toMatchObject({ retryable: true });
    await expect(worker.run(event())).resolves.toMatchObject({ disposition: 'unknown' });
    await expect(worker.run(event())).resolves.toMatchObject({ disposition: 'completed' });

    expect(platform.claims).toHaveLength(3);
    await expect(state(database)).resolves.toMatchObject({
      attemptCount: 3,
      attemptStatus: ['failed', 'failed', 'unknown'],
      automationStatus: 'publish_failed',
      jobStatus: 'failed',
      packageStatus: 'publish_failed',
      variantStatus: 'publish_failed',
    });
  });

  it('completes the official-site automation run and records the remote publication time', async () => {
    const database = requireClient(client);
    await enableAutomation(database);
    const worker = createWorker(
      database,
      requireCredentials(credentials),
      new FakePlatform({
        externalId: 'official-news-136',
        mode: 'api',
        payloadHash: PLATFORM_PAYLOAD_HASH,
        response: { published_at: '2026-07-23T01:02:03.000Z', status: 'published' },
        url: 'https://www.zhiyuanbj.cn/detail/news136.html',
      }),
    );

    await expect(worker.run(event())).resolves.toMatchObject({ disposition: 'processed' });
    await expect(state(database)).resolves.toMatchObject({
      automationStatus: 'published',
      jobStatus: 'published',
      publishedAt: '2026-07-23T01:02:03.000Z',
      variantStatus: 'published',
    });
  });

  it('stores an export artifact when the account has no publishing API', async () => {
    const database = requireClient(client);
    await database`
      UPDATE platform_accounts SET publish_mode='export', credential_ciphertext=NULL,
        credential_key_version=NULL WHERE id=${ACCOUNT_ID}::uuid
    `;
    const platform = new FakePlatform({
      bundle: { files: [{ name: 'post.json' }], schema_version: 'official-site-export@1' },
      mode: 'export',
      payloadHash: PLATFORM_PAYLOAD_HASH,
    });
    const storage = new InMemoryStorageAdapter('publisher-t125');
    const worker = createWorker(database, requireCredentials(credentials), platform, storage);

    await expect(worker.run(event())).resolves.toMatchObject({ mode: 'export' });
    const artifacts = await database<
      { contentHash: string; objectUri: string; schemaVersion: string }[]
    >`
      SELECT content_hash AS "contentHash", object_uri AS "objectUri",
        manifest_json->>'schema_version' AS "schemaVersion"
      FROM export_artifacts WHERE publish_job_id=${JOB_ID}::uuid
    `;
    expect(artifacts[0]).toMatchObject({
      objectUri: expect.stringContaining('memory://publisher-t125/'),
      schemaVersion: 'export-manifest@1',
    });
    expect(artifacts[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('retries only a safe pre-publication storage failure with attempts 1 and 2', async () => {
    const database = requireClient(client);
    await database`
      UPDATE platform_accounts SET publish_mode='export', credential_ciphertext=NULL,
        credential_key_version=NULL WHERE id=${ACCOUNT_ID}::uuid
    `;
    const platform = new FakePlatform({
      bundle: { files: [], schema_version: 'official-site-export@1' },
      mode: 'export',
      payloadHash: PLATFORM_PAYLOAD_HASH,
    });
    const first = createWorker(
      database,
      requireCredentials(credentials),
      platform,
      failingStorage(),
    );
    await expect(first.run(event())).rejects.toMatchObject({ code: 'PUBLISHER_STORAGE_FAILED' });
    await expect(state(database)).resolves.toMatchObject({
      attemptCount: 1,
      attemptStatus: ['failed'],
      jobStatus: 'scheduled',
      variantStatus: 'scheduled',
    });

    const second = createWorker(database, requireCredentials(credentials), platform);
    await expect(second.run(event())).resolves.toMatchObject({ attempt: 2, mode: 'export' });
    await expect(state(database)).resolves.toMatchObject({
      attemptCount: 2,
      attemptStatus: ['failed', 'succeeded'],
      jobStatus: 'published',
      variantStatus: 'published',
    });
  });
});

class FakePlatform implements PublisherPlatformPort {
  public readonly claims: PublishClaim[] = [];
  public readonly credentials: (Readonly<Record<string, unknown>> | null)[] = [];

  public constructor(
    private readonly result?: PlatformDelivery,
    private readonly errorCode?: string,
  ) {}

  public async deliver(
    claim: PublishClaim,
    credential: Readonly<Record<string, unknown>> | null,
  ): Promise<PlatformDelivery> {
    this.claims.push(claim);
    this.credentials.push(credential);
    if (this.errorCode) {
      throw Object.assign(new Error('access_token=must-not-be-persisted'), {
        code: this.errorCode,
      });
    }
    if (!this.result) throw new Error('Fake delivery result is missing');
    return this.result;
  }
}

function createWorker(
  database: Sql,
  credentials: CredentialEnvelopeService,
  platform: PublisherPlatformPort,
  storage: ObjectStorageAdapter = new InMemoryStorageAdapter('publisher-t125'),
): PublisherWorker {
  return new PublisherWorker(
    { platform, storage, store: new PostgresPublisherStore(database, 1_000) },
    credentials,
  );
}

function event() {
  return {
    aggregate: { id: JOB_ID, type: 'publish_job' },
    data: {
      job_id: JOB_ID,
      job_version: 1,
      request_id: 'req-publisher-worker-125',
      scheduled_at: '2026-01-01T00:00:00.000Z',
    },
    event_id: randomUUID(),
    event_type: 'publishing.job.execution_requested.v1',
    occurred_at: new Date().toISOString(),
    tenant: { id: TENANT_ID },
  };
}

async function state(database: Sql) {
  const jobs = await database<
    {
      attemptCount: number;
      automationStatus: string | null;
      jobStatus: string;
      packageStatus: string;
      publishedAt: Date | null;
      variantStatus: string;
    }[]
  >`
    SELECT job.status AS "jobStatus", job.attempt_count AS "attemptCount",
      job.published_at AS "publishedAt", automation.status AS "automationStatus",
      variant.status AS "variantStatus", package.status AS "packageStatus"
    FROM publish_jobs AS job
    JOIN content_variants AS variant ON variant.id=job.variant_id
    JOIN content_packages AS package ON package.id=variant.package_id
    LEFT JOIN official_site_automation_runs AS automation
      ON automation.publish_job_id=job.id AND automation.tenant_id=job.tenant_id
    WHERE job.id=${JOB_ID}::uuid
  `;
  const attempts = await database<{ status: string }[]>`
    SELECT status FROM publish_attempts WHERE publish_job_id=${JOB_ID}::uuid ORDER BY attempt_no
  `;
  return {
    ...jobs[0],
    attemptStatus: attempts.map(({ status }) => status),
    publishedAt: jobs[0]?.publishedAt?.toISOString() ?? null,
  };
}

async function enableAutomation(database: Sql): Promise<void> {
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
  await database`DELETE FROM publish_jobs WHERE id=${JOB_ID}::uuid`;
  await database`
    INSERT INTO publish_jobs(
      id,tenant_id,variant_id,content_version_id,account_id,scheduled_at,
      idempotency_key,payload_hash,status,origin,created_by
    ) VALUES(
      ${JOB_ID}::uuid,${TENANT_ID}::uuid,${VARIANT_ID}::uuid,${VERSION_ID}::uuid,
      ${ACCOUNT_ID}::uuid,'2026-01-01T00:00:00.000Z','publish-job-125-stable',
      ${CONTENT_HASH},'scheduled','official_site_automation',${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO official_site_automation_runs(
      id,tenant_id,policy_id,variant_id,content_version_id,status,publish_job_id
    ) VALUES(
      ${AUTOMATION_RUN_ID}::uuid,${TENANT_ID}::uuid,${POLICY_ID}::uuid,${VARIANT_ID}::uuid,
      ${VERSION_ID}::uuid,'publishing',${JOB_ID}::uuid
    )
  `;
}

async function seed(database: Sql, credentials: CredentialEnvelopeService): Promise<void> {
  const encrypted = await credentials.encrypt(JSON.stringify({ access_token: ACCESS_TOKEN }));
  await database`
    INSERT INTO users(id,email,display_name,status)
    VALUES(${USER_ID}::uuid,'publisher-125@example.com','Publisher','active')
  `;
  await database`
    INSERT INTO tenants(id,name,slug,status)
    VALUES(${TENANT_ID}::uuid,'Publisher Worker Tenant','publisher-worker-125','active')
  `;
  await database`
    INSERT INTO memberships(tenant_id,user_id,role_code,status)
    VALUES(${TENANT_ID}::uuid,${USER_ID}::uuid,'publisher','active')
  `;
  await database`
    INSERT INTO workspaces(id,tenant_id,name,slug,timezone,status)
    VALUES(${WORKSPACE_ID}::uuid,${TENANT_ID}::uuid,'Publishing','publishing-125','Asia/Shanghai','active')
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
    INSERT INTO briefs(
      id,tenant_id,workspace_id,project_id,title,objective,audience,
      platform_codes,constraints_json,created_by
    ) VALUES(
      ${BRIEF_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
      'Approved content','awareness','Enterprise audience',ARRAY['official_site']::varchar[],
      ${database.json({ schema_version: 'brief-constraints@1' })},${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO content_packages(
      id,tenant_id,workspace_id,project_id,brief_id,status,created_by
    ) VALUES(
      ${PACKAGE_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
      ${BRIEF_ID}::uuid,'scheduled',${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO content_variants(id,tenant_id,package_id,platform_code,status)
    VALUES(${VARIANT_ID}::uuid,${TENANT_ID}::uuid,${PACKAGE_ID}::uuid,'official_site','scheduled')
  `;
  await database`
    INSERT INTO content_versions(
      id,tenant_id,package_id,variant_id,version_no,schema_version,
      content_json,content_hash,created_by
    ) VALUES(
      ${VERSION_ID}::uuid,${TENANT_ID}::uuid,${PACKAGE_ID}::uuid,${VARIANT_ID}::uuid,
      1,'content-writer@1',${database.json({
        body: 'Approved publication body',
        schema_version: 'content-writer@1',
      })},${CONTENT_HASH},${USER_ID}::uuid
    )
  `;
  await database`
    UPDATE content_variants SET current_content_version_id=${VERSION_ID}::uuid
    WHERE id=${VARIANT_ID}::uuid
  `;
  await database`
    INSERT INTO platform_accounts(
      id,tenant_id,workspace_id,platform_code,provider_account_id,display_name,
      credential_ciphertext,credential_key_version,capabilities_json,publish_mode,status,timezone
    ) VALUES(
      ${ACCOUNT_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,'official_site',
      'provider-account-125','Official Site',${encrypted.credentialCiphertext},
      ${encrypted.credentialKeyVersion},${database.json({ export: true, publish: true })},
      'api','active','Asia/Shanghai'
    )
  `;
  await database`
    INSERT INTO publish_jobs(
      id,tenant_id,variant_id,content_version_id,account_id,scheduled_at,
      idempotency_key,payload_hash,status,created_by
    ) VALUES(
      ${JOB_ID}::uuid,${TENANT_ID}::uuid,${VARIANT_ID}::uuid,${VERSION_ID}::uuid,
      ${ACCOUNT_ID}::uuid,'2026-01-01T00:00:00.000Z','publish-job-125-stable',
      ${CONTENT_HASH},'scheduled',${USER_ID}::uuid
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

function failingStorage(): ObjectStorageAdapter {
  const storage = new InMemoryStorageAdapter('publisher-t125-failing');
  return {
    createDownloadUrl: (key, expires) => storage.createDownloadUrl(key, expires),
    deleteObject: (key) => storage.deleteObject(key),
    getObject: (key) => storage.getObject(key),
    headObject: (key) => storage.headObject(key),
    objectUri: (key) => storage.objectUri(key),
    putObject: async () => Promise.reject(new Error('storage unavailable')),
  };
}

function requireClient(value: Sql | undefined): Sql {
  if (!value) throw new Error('PostgreSQL client is not initialized');
  return value;
}

function requireCredentials(
  value: CredentialEnvelopeService | undefined,
): CredentialEnvelopeService {
  if (!value) throw new Error('Credential service is not initialized');
  return value;
}
