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
import type {
  BaijiahaoReconcileClaim,
  BaijiahaoRemoteStatus,
  PlatformDelivery,
  PublishClaim,
  PublisherPlatformPort,
} from './publisher.types.js';
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
const DAILY_BATCH_ID = 'a4000000-0000-4000-8000-000000000125';
const DAILY_ITEM_ID = 'a5000000-0000-4000-8000-000000000125';
const OFFICIAL_VARIANT_ID = 'b1000000-0000-4000-8000-000000000125';
const BROWSER_SESSION_ID = 'b2000000-0000-4000-8000-000000000125';
const BROWSER_PUBLICATION_ID = 'b3000000-0000-4000-8000-000000000125';
const CONTENT_HASH = 'a'.repeat(64);
const PLATFORM_PAYLOAD_HASH = 'b'.repeat(64);
const ACCESS_TOKEN = 't125-platform-secret';
const OWNER_COMPANY_NAME = '广东众人搬家起重吊装有限公司';
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
        content_versions, content_variants, content_packages, briefs, brand_profiles,
        workspace_memberships, projects, workspaces, audit_events, outbox_events,
        memberships, tenants, users
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
    expect(platform.claims[0]?.officialSiteServicePhone).toBe('02085627757');
    expect(platform.claims[0]?.ownerCompanyNames).toEqual([OWNER_COMPANY_NAME]);
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
    await seedDailyPublishItem(database);
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
    expect(
      await database<{ batchStatus: string; itemStatus: string }[]>`
        SELECT batch.status AS "batchStatus",item.status AS "itemStatus"
        FROM official_site_daily_batch_items AS item
        JOIN official_site_daily_batches AS batch
          ON batch.id=item.batch_id AND batch.tenant_id=item.tenant_id
        WHERE item.id=${DAILY_ITEM_ID}::uuid
      `,
    ).toEqual([{ batchStatus: 'attention_required', itemStatus: 'publish_failed' }]);
  });

  it('reserves an official Lieju submission and never retries an ambiguous response', async () => {
    const database = requireClient(client);
    await enableLiejuOfficialPublishing(database);
    const diagnostics = {
      body_bytes: 187,
      content_type: 'text/html',
      http_status: 200,
      raw_response: 'api_key=must-not-be-persisted',
      response_kind: 'html',
      response_sha256: 'a'.repeat(64),
      schema_version: 'lieju-official-response-diagnostics@1',
      signals: ['login_required'],
    };
    const platform = new FakePlatform(undefined, 'PUBLISH_STATE_UNKNOWN', [], diagnostics);
    const worker = createWorker(database, requireCredentials(credentials), platform);

    await expect(worker.run(event())).resolves.toMatchObject({ disposition: 'unknown' });
    await expect(worker.run(event())).resolves.toMatchObject({ disposition: 'completed' });

    expect(platform.claims).toHaveLength(1);
    expect(
      await database<{ attemptNo: number; status: string }[]>`
        SELECT attempt_no AS "attemptNo",status FROM lieju_api_publications
        WHERE publish_job_id=${JOB_ID}::uuid
      `,
    ).toEqual([{ attemptNo: 1, status: 'manual_required' }]);
    const diagnosticRows = await database<
      {
        attemptResponse: Readonly<Record<string, unknown>>;
        jobError: Readonly<Record<string, unknown>>;
        publicationError: Readonly<Record<string, unknown>>;
        responseHash: string | null;
      }[]
    >`
      SELECT attempt.response_json AS "attemptResponse",job.last_error_json AS "jobError",
        publication.last_error_json AS "publicationError",publication.response_hash AS "responseHash"
      FROM publish_jobs AS job
      JOIN publish_attempts AS attempt
        ON attempt.publish_job_id=job.id AND attempt.tenant_id=job.tenant_id
      JOIN lieju_api_publications AS publication
        ON publication.publish_job_id=job.id AND publication.tenant_id=job.tenant_id
      WHERE job.id=${JOB_ID}::uuid
    `;
    expect(diagnosticRows[0]).toMatchObject({
      attemptResponse: { diagnostics: { response_kind: 'html' } },
      jobError: { diagnostics: { response_sha256: 'a'.repeat(64) } },
      publicationError: { diagnostics: { http_status: 200 } },
      responseHash: 'a'.repeat(64),
    });
    expect(JSON.stringify(diagnosticRows)).not.toContain('must-not-be-persisted');
    await expect(state(database)).resolves.toMatchObject({
      attemptCount: 1,
      attemptStatus: ['unknown'],
      jobStatus: 'failed',
      variantStatus: 'publish_failed',
    });
  });

  it('records an invalid Lieju posting profile as rejected without claiming an unknown submission', async () => {
    const database = requireClient(client);
    await enableLiejuOfficialPublishing(database);
    const platform = new FakePlatform(undefined, 'PLATFORM_ACCOUNT_CONFIGURATION_INVALID');
    const worker = createWorker(database, requireCredentials(credentials), platform);

    await expect(worker.run(event())).resolves.toMatchObject({ disposition: 'processed' });

    expect(platform.claims).toHaveLength(1);
    expect(
      await database<{ status: string }[]>`
        SELECT status FROM lieju_api_publications
        WHERE publish_job_id=${JOB_ID}::uuid
      `,
    ).toEqual([{ status: 'rejected' }]);
    await expect(state(database)).resolves.toMatchObject({
      attemptCount: 1,
      attemptStatus: ['failed'],
      jobStatus: 'failed',
      variantStatus: 'publish_failed',
    });
  });

  it('completes the Lieju automation batch after the platform explicitly accepts submission', async () => {
    const database = requireClient(client);
    await enableLiejuOfficialAutomationPublishing(database);
    const platform = new FakePlatform({
      externalId: '105862105',
      mode: 'api',
      payloadHash: PLATFORM_PAYLOAD_HASH,
      response: { status: 'published' },
      url: 'https://gz.lieju.com/banjia/105862105.html',
    });
    const worker = createWorker(database, requireCredentials(credentials), platform);

    await expect(worker.run(event())).resolves.toMatchObject({ disposition: 'processed' });

    expect(
      await database<
        {
          automationStatus: string;
          batchStatus: string;
          itemStatus: string;
          jobStatus: string;
          publicationStatus: string;
        }[]
      >`
        SELECT job.status AS "jobStatus",automation.status AS "automationStatus",
          item.status AS "itemStatus",batch.status AS "batchStatus",
          publication.status AS "publicationStatus"
        FROM publish_jobs AS job
        JOIN lieju_api_publications AS publication ON publication.publish_job_id=job.id
        JOIN browser_platform_automation_runs AS automation ON automation.publish_job_id=job.id
        JOIN browser_platform_daily_batch_items AS item ON item.publish_job_id=job.id
        JOIN browser_platform_daily_batches AS batch ON batch.id=item.batch_id
        WHERE job.id=${JOB_ID}::uuid
      `,
    ).toEqual([
      {
        automationStatus: 'published',
        batchStatus: 'completed',
        itemStatus: 'published',
        jobStatus: 'published',
        publicationStatus: 'published',
      },
    ]);
  });

  it('stops a Baijiahao unknown state after attempt three without claiming rejection', async () => {
    const database = requireClient(client);
    await enableBaijiahaoAutomation(database);
    const platform = new FakePlatform(undefined, 'PUBLISH_STATE_UNKNOWN');
    const worker = createWorker(database, requireCredentials(credentials), platform);

    await expect(worker.run(event())).rejects.toMatchObject({ retryable: true });
    await expect(worker.run(event())).rejects.toMatchObject({ retryable: true });
    await expect(worker.run(event())).resolves.toMatchObject({ disposition: 'unknown' });

    expect(platform.claims).toHaveLength(3);
    expect(
      await database<
        {
          automationStatus: string;
          batchStatus: string;
          browserStatus: string;
          itemStatus: string;
          jobStatus: string;
        }[]
      >`
        SELECT job.status AS "jobStatus",automation.status AS "automationStatus",
          publication.status AS "browserStatus",item.status AS "itemStatus",
          batch.status AS "batchStatus"
        FROM publish_jobs AS job
        JOIN baijiahao_automation_runs AS automation ON automation.publish_job_id=job.id
        JOIN baijiahao_browser_publications AS publication ON publication.publish_job_id=job.id
        JOIN baijiahao_daily_batch_items AS item ON item.publish_job_id=job.id
        JOIN baijiahao_daily_batches AS batch ON batch.id=item.batch_id
        WHERE job.id=${JOB_ID}::uuid
      `,
    ).toEqual([
      {
        automationStatus: 'manual_required',
        batchStatus: 'attention_required',
        browserStatus: 'manual_required',
        itemStatus: 'manual_required',
        jobStatus: 'failed',
      },
    ]);
  });

  it('retries instead of exporting when an automatic Baijiahao API account loses browser capability', async () => {
    const database = requireClient(client);
    await enableBaijiahaoAutomation(database);
    const platform = new FakePlatform({
      bundle: { files: [], schema_version: 'baijiahao-export@1' },
      mode: 'export',
      payloadHash: PLATFORM_PAYLOAD_HASH,
    });
    const worker = createWorker(database, requireCredentials(credentials), platform);

    await expect(worker.run(event())).rejects.toMatchObject({ retryable: true });
    await expect(worker.run(event())).rejects.toMatchObject({ retryable: true });
    await expect(worker.run(event())).resolves.toMatchObject({ disposition: 'processed' });

    expect(platform.claims).toHaveLength(3);
    await expect(state(database)).resolves.toMatchObject({
      attemptCount: 3,
      attemptStatus: ['failed', 'failed', 'failed'],
      jobStatus: 'failed',
      packageStatus: 'published',
      variantStatus: 'publish_failed',
    });
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM export_artifacts
        WHERE publish_job_id=${JOB_ID}::uuid
      `,
    ).toEqual([{ count: 0 }]);
  });

  it('completes the official-site automation run and records the remote publication time', async () => {
    const database = requireClient(client);
    await enableAutomation(database);
    await seedDailyPublishItem(database);
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
    expect(
      await database<{ publishedAt: Date | null; status: string }[]>`
        SELECT status,published_at AS "publishedAt"
        FROM official_site_daily_batch_items WHERE id=${DAILY_ITEM_ID}::uuid
      `,
    ).toEqual([{ publishedAt: expect.any(Date), status: 'published' }]);
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

  it('reconciles a browser submission from processing to published without changing the official variant', async () => {
    const database = requireClient(client);
    await enableBaijiahaoAutomation(database);
    const platform = new FakePlatform(
      {
        externalId: 'baijiahao-t145',
        mode: 'api',
        payloadHash: PLATFORM_PAYLOAD_HASH,
        response: { status: 'processing' },
        url: null,
      },
      undefined,
      [
        { externalId: 'baijiahao-t145', status: 'processing', url: null },
        { externalId: 'baijiahao-t145', status: 'processing', url: null },
        { externalId: 'baijiahao-t145', status: 'processing', url: null },
        {
          externalId: 'baijiahao-t145',
          status: 'published',
          url: 'https://baijiahao.baidu.com/s?id=t145',
        },
      ],
    );
    const worker = createWorker(database, requireCredentials(credentials), platform);

    await expect(worker.run(event())).resolves.toMatchObject({ disposition: 'processed' });
    await expect(reconcileSchedules(database, 'baijiahao')).resolves.toEqual([
      { delaySeconds: 60, reconcileAttempt: 1 },
    ]);
    await expect(
      worker.reconcileBaijiahao(await latestReconcileEvent(database)),
    ).resolves.toMatchObject({ disposition: 'processed' });
    await expect(reconcileSchedules(database, 'baijiahao')).resolves.toEqual([
      { delaySeconds: 60, reconcileAttempt: 1 },
      { delaySeconds: 120, reconcileAttempt: 2 },
    ]);
    await expect(
      worker.reconcileBaijiahao(await latestReconcileEvent(database)),
    ).resolves.toMatchObject({ disposition: 'processed' });
    await expect(reconcileSchedules(database, 'baijiahao')).resolves.toEqual([
      { delaySeconds: 60, reconcileAttempt: 1 },
      { delaySeconds: 120, reconcileAttempt: 2 },
      { delaySeconds: 120, reconcileAttempt: 3 },
    ]);
    await expect(
      worker.reconcileBaijiahao(await latestReconcileEvent(database)),
    ).resolves.toMatchObject({ disposition: 'processed' });
    await expect(reconcileSchedules(database, 'baijiahao')).resolves.toEqual([
      { delaySeconds: 60, reconcileAttempt: 1 },
      { delaySeconds: 120, reconcileAttempt: 2 },
      { delaySeconds: 120, reconcileAttempt: 3 },
      { delaySeconds: 300, reconcileAttempt: 4 },
    ]);
    await database`
      UPDATE baijiahao_browser_publications SET
        status='published',external_url='https://baijiahao.baidu.com/s?id=t145',
        last_reconciled_at=now(),version=version+1
      WHERE publish_job_id=${JOB_ID}::uuid
    `;
    await expect(
      worker.reconcileBaijiahao(await latestReconcileEvent(database)),
    ).resolves.toMatchObject({ disposition: 'completed' });

    expect(platform.statusClaims).toHaveLength(4);
    expect(
      await database<
        {
          adapterCode: string;
          automationStatus: string;
          browserStatus: string;
          itemStatus: string;
          jobStatus: string;
          packageStatus: string;
          variantStatus: string;
        }[]
      >`
        SELECT job.status AS "jobStatus",automation.status AS "automationStatus",
          publication.status AS "browserStatus",item.status AS "itemStatus",
          variant.status AS "variantStatus",package.status AS "packageStatus",
          attempt.adapter_code AS "adapterCode"
        FROM publish_jobs AS job
        JOIN baijiahao_automation_runs AS automation ON automation.publish_job_id=job.id
        JOIN baijiahao_browser_publications AS publication ON publication.publish_job_id=job.id
        JOIN baijiahao_daily_batch_items AS item ON item.publish_job_id=job.id
        JOIN content_variants AS variant ON variant.id=job.variant_id
        JOIN content_packages AS package ON package.id=variant.package_id
        JOIN publish_attempts AS attempt ON attempt.publish_job_id=job.id
        WHERE job.id=${JOB_ID}::uuid
      `,
    ).toEqual([
      {
        adapterCode: 'baijiahao-delivery@1.1.0',
        automationStatus: 'published',
        browserStatus: 'published',
        itemStatus: 'published',
        jobStatus: 'published',
        packageStatus: 'published',
        variantStatus: 'published',
      },
    ]);
    expect(
      await database<{ status: string }[]>`
        SELECT status FROM content_variants WHERE id=${OFFICIAL_VARIANT_ID}::uuid
      `,
    ).toEqual([{ status: 'published' }]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM outbox_events
        WHERE event_type='publishing.job.published.v1'
      `,
    ).toEqual([{ count: 1 }]);
  });

  it('reconciles when the browser worker already recorded a failed terminal state', async () => {
    const database = requireClient(client);
    await enableBaijiahaoAutomation(database);
    const platform = new FakePlatform(
      {
        externalId: 'baijiahao-failed-t145',
        mode: 'api',
        payloadHash: PLATFORM_PAYLOAD_HASH,
        response: { status: 'processing' },
        url: null,
      },
      undefined,
      [{ externalId: 'baijiahao-failed-t145', status: 'failed', url: null }],
    );
    const worker = createWorker(database, requireCredentials(credentials), platform);

    await expect(worker.run(event())).resolves.toMatchObject({ disposition: 'processed' });
    await database`
      UPDATE baijiahao_browser_publications SET
        status='failed',review_reason='Baijiahao rejected the submitted article.',
        last_reconciled_at=now(),version=version+1
      WHERE publish_job_id=${JOB_ID}::uuid
    `;
    await expect(
      worker.reconcileBaijiahao(await latestReconcileEvent(database)),
    ).resolves.toMatchObject({ disposition: 'completed' });

    expect(
      await database<
        {
          automationStatus: string;
          browserStatus: string;
          itemStatus: string;
          jobStatus: string;
          variantStatus: string;
        }[]
      >`
        SELECT job.status AS "jobStatus",automation.status AS "automationStatus",
          publication.status AS "browserStatus",item.status AS "itemStatus",
          variant.status AS "variantStatus"
        FROM publish_jobs AS job
        JOIN baijiahao_automation_runs AS automation ON automation.publish_job_id=job.id
        JOIN baijiahao_browser_publications AS publication ON publication.publish_job_id=job.id
        JOIN baijiahao_daily_batch_items AS item ON item.publish_job_id=job.id
        JOIN content_variants AS variant ON variant.id=job.variant_id
        WHERE job.id=${JOB_ID}::uuid
      `,
    ).toEqual([
      {
        automationStatus: 'publish_failed',
        browserStatus: 'failed',
        itemStatus: 'publish_failed',
        jobStatus: 'failed',
        variantStatus: 'publish_failed',
      },
    ]);
  });

  it('reconciles a manual Baijiahao browser submission without updating automation rows', async () => {
    const database = requireClient(client);
    await enableBaijiahaoAutomation(database, 'manual');
    const platform = new FakePlatform(
      {
        externalId: 'baijiahao-manual-t145',
        mode: 'api',
        payloadHash: PLATFORM_PAYLOAD_HASH,
        response: { status: 'processing' },
        url: null,
      },
      undefined,
      [
        {
          externalId: 'baijiahao-manual-t145',
          status: 'published',
          url: 'https://baijiahao.baidu.com/s?id=manual-t145',
        },
      ],
    );
    const worker = createWorker(database, requireCredentials(credentials), platform);

    await expect(worker.run(event())).resolves.toMatchObject({ disposition: 'processed' });
    await expect(
      worker.reconcileBaijiahao(await latestReconcileEvent(database)),
    ).resolves.toMatchObject({ disposition: 'completed' });

    expect(
      await database<
        {
          automationStatus: string;
          browserStatus: string;
          itemStatus: string;
          jobStatus: string;
          variantStatus: string;
        }[]
      >`
        SELECT job.status AS "jobStatus",automation.status AS "automationStatus",
          publication.status AS "browserStatus",item.status AS "itemStatus",
          variant.status AS "variantStatus"
        FROM publish_jobs AS job
        JOIN baijiahao_automation_runs AS automation ON automation.publish_job_id=job.id
        JOIN baijiahao_browser_publications AS publication ON publication.publish_job_id=job.id
        JOIN baijiahao_daily_batch_items AS item ON item.publish_job_id=job.id
        JOIN content_variants AS variant ON variant.id=job.variant_id
        WHERE job.id=${JOB_ID}::uuid
      `,
    ).toEqual([
      {
        automationStatus: 'scheduled',
        browserStatus: 'published',
        itemStatus: 'scheduled',
        jobStatus: 'published',
        variantStatus: 'published',
      },
    ]);
  });

  it('reconciles a manual Sohu browser submission from processing to published', async () => {
    const database = requireClient(client);
    await enableSohuManualPublishing(database);
    const platform = new FakePlatform(
      {
        externalId: 'sohu-manual-t150',
        mode: 'api',
        payloadHash: PLATFORM_PAYLOAD_HASH,
        response: { status: 'processing' },
        url: null,
      },
      undefined,
      [
        {
          externalId: 'sohu-manual-t150',
          status: 'published',
          url: 'https://mp.sohu.com/profile?contentId=sohu-manual-t150',
        },
      ],
    );
    const worker = createWorker(database, requireCredentials(credentials), platform);

    await expect(worker.run(event())).resolves.toMatchObject({ disposition: 'processed' });
    await expect(reconcileSchedules(database, 'sohu')).resolves.toEqual([
      { delaySeconds: 300, reconcileAttempt: 1 },
    ]);
    await expect(
      worker.reconcileBaijiahao(await latestSohuReconcileEvent(database)),
    ).resolves.toMatchObject({ disposition: 'completed' });

    expect(platform.statusClaims).toHaveLength(1);
    expect(platform.statusClaims[0]?.platformCode).toBe('sohu');
    expect(
      await database<
        {
          adapterCode: string;
          browserStatus: string;
          jobStatus: string;
          packageStatus: string;
          variantStatus: string;
        }[]
      >`
        SELECT job.status AS "jobStatus",publication.status AS "browserStatus",
          variant.status AS "variantStatus",package.status AS "packageStatus",
          attempt.adapter_code AS "adapterCode"
        FROM publish_jobs AS job
        JOIN sohu_browser_publications AS publication ON publication.publish_job_id=job.id
        JOIN content_variants AS variant ON variant.id=job.variant_id
        JOIN content_packages AS package ON package.id=variant.package_id
        JOIN publish_attempts AS attempt ON attempt.publish_job_id=job.id
        WHERE job.id=${JOB_ID}::uuid
      `,
    ).toEqual([
      {
        adapterCode: 'sohu-delivery@1.0.0',
        browserStatus: 'published',
        jobStatus: 'published',
        packageStatus: 'published',
        variantStatus: 'published',
      },
    ]);
  });

  it('completes the Sohu automation run and daily batch after remote publication', async () => {
    const database = requireClient(client);
    await enableSohuAutomationPublishing(database);
    const platform = new FakePlatform(
      {
        externalId: 'sohu-automation-t153',
        mode: 'api',
        payloadHash: PLATFORM_PAYLOAD_HASH,
        response: { status: 'processing' },
        url: null,
      },
      undefined,
      [
        {
          externalId: 'sohu-automation-t153',
          status: 'published',
          url: 'https://mp.sohu.com/profile?contentId=sohu-automation-t153',
        },
      ],
    );
    const worker = createWorker(database, requireCredentials(credentials), platform);

    await expect(worker.run(event())).resolves.toMatchObject({ disposition: 'processed' });
    await expect(
      worker.reconcileBaijiahao(await latestSohuReconcileEvent(database)),
    ).resolves.toMatchObject({ disposition: 'completed' });

    expect(
      await database<
        {
          automationStatus: string;
          batchStatus: string;
          itemStatus: string;
          jobStatus: string;
        }[]
      >`
        SELECT job.status AS "jobStatus",automation.status AS "automationStatus",
          item.status AS "itemStatus",batch.status AS "batchStatus"
        FROM publish_jobs AS job
        JOIN browser_platform_automation_runs AS automation ON automation.publish_job_id=job.id
        JOIN browser_platform_daily_batch_items AS item ON item.publish_job_id=job.id
        JOIN browser_platform_daily_batches AS batch ON batch.id=item.batch_id
        WHERE job.id=${JOB_ID}::uuid
      `,
    ).toEqual([
      {
        automationStatus: 'published',
        batchStatus: 'completed',
        itemStatus: 'published',
        jobStatus: 'published',
      },
    ]);
  });

  it('requires manual handling when review is still processing after twelve reconciliations', async () => {
    const database = requireClient(client);
    await enableBaijiahaoAutomation(database);
    const platform = new FakePlatform(
      {
        externalId: 'baijiahao-t145',
        mode: 'api',
        payloadHash: PLATFORM_PAYLOAD_HASH,
        response: { status: 'processing' },
        url: null,
      },
      undefined,
      [{ externalId: 'baijiahao-t145', status: 'processing', url: null }],
    );
    const worker = createWorker(database, requireCredentials(credentials), platform);

    await worker.run(event());
    const current = await database<{ version: number }[]>`
      SELECT version FROM publish_jobs WHERE id=${JOB_ID}::uuid
    `;
    await expect(
      worker.reconcileBaijiahao(reconcileEvent(current[0]?.version ?? 0, 12)),
    ).resolves.toMatchObject({ disposition: 'completed' });

    expect(
      await database<
        {
          automationStatus: string;
          batchStatus: string;
          browserStatus: string;
          errorCode: string;
          itemStatus: string;
          jobStatus: string;
          packageStatus: string;
          variantStatus: string;
        }[]
      >`
        SELECT job.status AS "jobStatus",automation.status AS "automationStatus",
          automation.last_error_json->>'code' AS "errorCode",
          publication.status AS "browserStatus",item.status AS "itemStatus",
          batch.status AS "batchStatus",variant.status AS "variantStatus",
          package.status AS "packageStatus"
        FROM publish_jobs AS job
        JOIN baijiahao_automation_runs AS automation ON automation.publish_job_id=job.id
        JOIN baijiahao_browser_publications AS publication ON publication.publish_job_id=job.id
        JOIN baijiahao_daily_batch_items AS item ON item.publish_job_id=job.id
        JOIN baijiahao_daily_batches AS batch ON batch.id=item.batch_id
        JOIN content_variants AS variant ON variant.id=job.variant_id
        JOIN content_packages AS package ON package.id=variant.package_id
        WHERE job.id=${JOB_ID}::uuid
      `,
    ).toEqual([
      {
        automationStatus: 'manual_required',
        batchStatus: 'attention_required',
        browserStatus: 'manual_required',
        errorCode: 'BAIJIAHAO_REVIEW_PENDING_TIMEOUT',
        itemStatus: 'manual_required',
        jobStatus: 'failed',
        packageStatus: 'published',
        variantStatus: 'publish_failed',
      },
    ]);
    expect(
      await database<{ status: string }[]>`
        SELECT status FROM content_variants WHERE id=${OFFICIAL_VARIANT_ID}::uuid
      `,
    ).toEqual([{ status: 'published' }]);
  });
});

class FakePlatform implements PublisherPlatformPort {
  public readonly claims: PublishClaim[] = [];
  public readonly credentials: (Readonly<Record<string, unknown>> | null)[] = [];
  public readonly statusClaims: BaijiahaoReconcileClaim[] = [];

  public constructor(
    private readonly result?: PlatformDelivery,
    private readonly errorCode?: string,
    private readonly statuses: BaijiahaoRemoteStatus[] = [],
    private readonly diagnostics?: Readonly<Record<string, unknown>>,
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
        ...(this.diagnostics ? { diagnostics: this.diagnostics } : {}),
      });
    }
    if (!this.result) throw new Error('Fake delivery result is missing');
    return this.result;
  }

  public async getBaijiahaoStatus(claim: BaijiahaoReconcileClaim): Promise<BaijiahaoRemoteStatus> {
    this.statusClaims.push(claim);
    const status = this.statuses.shift();
    if (!status) throw new Error('Fake Baijiahao status is missing');
    return status;
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

function reconcileEvent(jobVersion: number, reconcileAttempt: number) {
  return {
    aggregate: { id: JOB_ID, type: 'publish_job' },
    data: {
      account_id: ACCOUNT_ID,
      external_post_id: null,
      job_id: JOB_ID,
      job_version: jobVersion,
      reconcile_attempt: reconcileAttempt,
      request_id: 'req-baijiahao-reconcile-125',
    },
    event_id: randomUUID(),
    event_type: 'baijiahao.publication.reconcile_requested.v1',
    occurred_at: new Date().toISOString(),
    tenant: { id: TENANT_ID },
  } as const;
}

async function latestReconcileEvent(database: Sql): Promise<unknown> {
  const events = await database<{ payload: unknown }[]>`
    SELECT payload_json AS payload FROM outbox_events
    WHERE event_type='baijiahao.publication.reconcile_requested.v1'
    ORDER BY (payload_json->'data'->>'reconcile_attempt')::integer DESC,id DESC
    LIMIT 1
  `;
  const payload = events[0]?.payload;
  if (!payload) throw new Error('Baijiahao reconciliation event was not queued');
  return payload;
}

async function latestSohuReconcileEvent(database: Sql): Promise<unknown> {
  const events = await database<{ payload: unknown }[]>`
    SELECT payload_json AS payload FROM outbox_events
    WHERE event_type='sohu.publication.reconcile_requested.v1'
    ORDER BY (payload_json->'data'->>'reconcile_attempt')::integer DESC,id DESC
    LIMIT 1
  `;
  const payload = events[0]?.payload;
  if (!payload) throw new Error('Sohu reconciliation event was not queued');
  return payload;
}

async function reconcileSchedules(database: Sql, platformCode: 'baijiahao' | 'sohu') {
  return database<{ delaySeconds: number; reconcileAttempt: number }[]>`
    SELECT
      EXTRACT(EPOCH FROM (next_attempt_at-created_at))::integer AS "delaySeconds",
      (payload_json->'data'->>'reconcile_attempt')::integer AS "reconcileAttempt"
    FROM outbox_events
    WHERE event_type=${`${platformCode}.publication.reconcile_requested.v1`}
    ORDER BY (payload_json->'data'->>'reconcile_attempt')::integer,id
  `;
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

async function seedDailyPublishItem(database: Sql): Promise<void> {
  await database`
    UPDATE official_site_automation_policies SET daily_enabled=true
    WHERE id=${POLICY_ID}::uuid
  `;
  await database`
    INSERT INTO official_site_daily_batches(
      id,tenant_id,policy_id,business_date,status,scheduled_at
    ) VALUES(
      ${DAILY_BATCH_ID}::uuid,${TENANT_ID}::uuid,${POLICY_ID}::uuid,
      DATE '2026-07-23','scheduled',now()
    )
  `;
  await database`
    INSERT INTO official_site_daily_batch_items(
      id,tenant_id,batch_id,candidate_no,angle_key,title,
      brief_id,package_id,variant_id,content_version_id,publish_job_id,
      status,qualified_at,scheduled_at
    ) VALUES(
      ${DAILY_ITEM_ID}::uuid,${TENANT_ID}::uuid,${DAILY_BATCH_ID}::uuid,1,
      'selection-guide','Approved content',
      ${BRIEF_ID}::uuid,${PACKAGE_ID}::uuid,${VARIANT_ID}::uuid,
      ${VERSION_ID}::uuid,${JOB_ID}::uuid,'scheduled',now(),now()
    )
  `;
}

async function enableBaijiahaoAutomation(
  database: Sql,
  origin: 'baijiahao_automation' | 'manual' = 'baijiahao_automation',
): Promise<void> {
  await database`DELETE FROM publish_jobs WHERE id=${JOB_ID}::uuid`;
  await database`
    UPDATE briefs SET platform_codes=ARRAY['official_site','baijiahao']::varchar[]
    WHERE id=${BRIEF_ID}::uuid
  `;
  await database`
    UPDATE platform_accounts SET
      platform_code='baijiahao',provider_account_id='baijiahao-t145',
      display_name='Baijiahao T145',
      capabilities_json=${database.json({ get_status: true, publish: true })},
      publish_mode='api',status='active'
    WHERE id=${ACCOUNT_ID}::uuid
  `;
  await database`
    UPDATE content_variants SET
      platform_code='baijiahao',platform_account_id=${ACCOUNT_ID}::uuid,
      status='scheduled',is_required=false
    WHERE id=${VARIANT_ID}::uuid
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
    UPDATE content_packages SET status='published'
    WHERE id=${PACKAGE_ID}::uuid
  `;
  await database`
    INSERT INTO baijiahao_automation_policies(
      id,tenant_id,workspace_id,project_id,account_id,enabled,source_mode,
      daily_enabled,created_by
    ) VALUES(
      ${POLICY_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
      ${ACCOUNT_ID}::uuid,true,'independent',true,${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO publish_jobs(
      id,tenant_id,variant_id,content_version_id,account_id,scheduled_at,
      idempotency_key,payload_hash,status,origin,created_by
    ) VALUES(
      ${JOB_ID}::uuid,${TENANT_ID}::uuid,${VARIANT_ID}::uuid,${VERSION_ID}::uuid,
      ${ACCOUNT_ID}::uuid,'2026-01-01T00:00:00.000Z','publish-job-125-stable',
      ${CONTENT_HASH},'scheduled',${origin},${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO baijiahao_automation_runs(
      id,tenant_id,policy_id,source_mode,variant_id,content_version_id,
      status,publish_job_id
    ) VALUES(
      ${AUTOMATION_RUN_ID}::uuid,${TENANT_ID}::uuid,${POLICY_ID}::uuid,'independent',
      ${VARIANT_ID}::uuid,${VERSION_ID}::uuid,'scheduled',${JOB_ID}::uuid
    )
  `;
  await database`
    INSERT INTO baijiahao_daily_batches(
      id,tenant_id,policy_id,business_date,status,scheduled_at
    ) VALUES(
      ${DAILY_BATCH_ID}::uuid,${TENANT_ID}::uuid,${POLICY_ID}::uuid,
      DATE '2026-07-23','scheduled',now()
    )
  `;
  await database`
    INSERT INTO baijiahao_daily_batch_items(
      id,tenant_id,batch_id,candidate_no,automation_run_id,brief_id,package_id,
      variant_id,content_version_id,publish_job_id,status,qualified_at,scheduled_at
    ) VALUES(
      ${DAILY_ITEM_ID}::uuid,${TENANT_ID}::uuid,${DAILY_BATCH_ID}::uuid,1,
      ${AUTOMATION_RUN_ID}::uuid,${BRIEF_ID}::uuid,${PACKAGE_ID}::uuid,
      ${VARIANT_ID}::uuid,${VERSION_ID}::uuid,${JOB_ID}::uuid,
      'scheduled',now(),now()
    )
  `;
  await database`
    INSERT INTO baijiahao_browser_sessions(
      id,tenant_id,account_id,status,profile_key,authenticated_at,last_verified_at
    ) VALUES(
      ${BROWSER_SESSION_ID}::uuid,${TENANT_ID}::uuid,${ACCOUNT_ID}::uuid,
      'authenticated','tenants/t125/accounts/baijiahao',now(),now()
    )
  `;
  await database`
    INSERT INTO baijiahao_browser_publications(
      id,tenant_id,session_id,account_id,publish_job_id,content_version_id,
      idempotency_key,payload_hash,content_fingerprint,title,status,field_summary_json,
      submitted_at
    ) VALUES(
      ${BROWSER_PUBLICATION_ID}::uuid,${TENANT_ID}::uuid,${BROWSER_SESSION_ID}::uuid,
      ${ACCOUNT_ID}::uuid,${JOB_ID}::uuid,${VERSION_ID}::uuid,
      'publish-job-125-stable',${CONTENT_HASH},${'c'.repeat(64)},
      '百家号测试文章','submitting','{}'::jsonb,now()
    )
  `;
}

async function enableSohuManualPublishing(
  database: Sql,
  origin: 'manual' | 'sohu_automation' = 'manual',
): Promise<void> {
  await database`DELETE FROM publish_jobs WHERE id=${JOB_ID}::uuid`;
  await database`
    UPDATE briefs SET platform_codes=ARRAY['sohu']::varchar[]
    WHERE id=${BRIEF_ID}::uuid
  `;
  await database`
    UPDATE platform_accounts SET
      platform_code='sohu',provider_account_id='sohu-t150',display_name='Sohu T150',
      capabilities_json=${database.json({ get_status: true, metrics: false, publish: true })},
      publish_mode='api',status='active'
    WHERE id=${ACCOUNT_ID}::uuid
  `;
  await database`
    UPDATE content_variants SET
      platform_code='sohu',platform_account_id=${ACCOUNT_ID}::uuid,
      status='scheduled',is_required=true
    WHERE id=${VARIANT_ID}::uuid
  `;
  await database`
    INSERT INTO publish_jobs(
      id,tenant_id,variant_id,content_version_id,account_id,scheduled_at,
      idempotency_key,payload_hash,status,origin,created_by
    ) VALUES(
      ${JOB_ID}::uuid,${TENANT_ID}::uuid,${VARIANT_ID}::uuid,${VERSION_ID}::uuid,
      ${ACCOUNT_ID}::uuid,'2026-01-01T00:00:00.000Z','publish-job-125-stable',
      ${CONTENT_HASH},'scheduled',${origin},${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO sohu_browser_sessions(
      id,tenant_id,account_id,status,profile_key,authenticated_at,last_verified_at
    ) VALUES(
      ${BROWSER_SESSION_ID}::uuid,${TENANT_ID}::uuid,${ACCOUNT_ID}::uuid,
      'authenticated','tenants/t125/accounts/sohu',now(),now()
    )
  `;
  await database`
    INSERT INTO sohu_browser_publications(
      id,tenant_id,session_id,account_id,publish_job_id,content_version_id,
      idempotency_key,payload_hash,content_fingerprint,title,status,field_summary_json,
      submitted_at
    ) VALUES(
      ${BROWSER_PUBLICATION_ID}::uuid,${TENANT_ID}::uuid,${BROWSER_SESSION_ID}::uuid,
      ${ACCOUNT_ID}::uuid,${JOB_ID}::uuid,${VERSION_ID}::uuid,
      'publish-job-125-stable',${CONTENT_HASH},${'c'.repeat(64)},
      '搜狐号测试文章','submitting','{}'::jsonb,now()
    )
  `;
}

async function enableLiejuOfficialPublishing(
  database: Sql,
  origin: 'lieju_automation' | 'manual' = 'manual',
): Promise<void> {
  await database`DELETE FROM publish_jobs WHERE id=${JOB_ID}::uuid`;
  await database`
    UPDATE briefs SET platform_codes=ARRAY['lieju']::varchar[]
    WHERE id=${BRIEF_ID}::uuid
  `;
  await database`
    UPDATE platform_accounts SET
      platform_code='lieju',provider_account_id=NULL,display_name='Lieju Official API',
      capabilities_json=${database.json({
        delivery_method: 'official_api',
        get_status: false,
        metrics: false,
        publish: true,
      })},publish_mode='api',status='active'
    WHERE id=${ACCOUNT_ID}::uuid
  `;
  await database`
    UPDATE content_variants SET
      platform_code='lieju',platform_account_id=${ACCOUNT_ID}::uuid,
      status='scheduled',is_required=true
    WHERE id=${VARIANT_ID}::uuid
  `;
  await database`
    INSERT INTO publish_jobs(
      id,tenant_id,variant_id,content_version_id,account_id,scheduled_at,
      idempotency_key,payload_hash,status,origin,created_by
    ) VALUES(
      ${JOB_ID}::uuid,${TENANT_ID}::uuid,${VARIANT_ID}::uuid,${VERSION_ID}::uuid,
      ${ACCOUNT_ID}::uuid,'2026-01-01T00:00:00.000Z','publish-job-125-stable',
      ${CONTENT_HASH},'scheduled',${origin},${USER_ID}::uuid
    )
  `;
}

async function enableLiejuOfficialAutomationPublishing(database: Sql): Promise<void> {
  await enableLiejuOfficialPublishing(database, 'lieju_automation');
  await database`
    INSERT INTO browser_platform_automation_policies(
      id,tenant_id,workspace_id,project_id,account_id,platform_code,
      enabled,daily_enabled,created_by
    ) VALUES(
      ${POLICY_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
      ${ACCOUNT_ID}::uuid,'lieju',true,true,${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO browser_platform_automation_runs(
      id,tenant_id,policy_id,platform_code,variant_id,content_version_id,
      status,publish_job_id
    ) VALUES(
      ${AUTOMATION_RUN_ID}::uuid,${TENANT_ID}::uuid,${POLICY_ID}::uuid,'lieju',
      ${VARIANT_ID}::uuid,${VERSION_ID}::uuid,'scheduled',${JOB_ID}::uuid
    )
  `;
  await database`
    INSERT INTO browser_platform_daily_batches(
      id,tenant_id,policy_id,business_date,status,scheduled_at
    ) VALUES(
      ${DAILY_BATCH_ID}::uuid,${TENANT_ID}::uuid,${POLICY_ID}::uuid,
      DATE '2026-08-19','scheduled',now()
    )
  `;
  await database`
    INSERT INTO browser_platform_daily_batch_items(
      id,tenant_id,batch_id,candidate_no,automation_run_id,brief_id,package_id,
      variant_id,content_version_id,publish_job_id,status,qualified_at,scheduled_at
    ) VALUES(
      ${DAILY_ITEM_ID}::uuid,${TENANT_ID}::uuid,${DAILY_BATCH_ID}::uuid,1,
      ${AUTOMATION_RUN_ID}::uuid,${BRIEF_ID}::uuid,${PACKAGE_ID}::uuid,
      ${VARIANT_ID}::uuid,${VERSION_ID}::uuid,${JOB_ID}::uuid,
      'scheduled',now(),now()
    )
  `;
}

async function enableSohuAutomationPublishing(database: Sql): Promise<void> {
  await enableSohuManualPublishing(database, 'sohu_automation');
  await database`
    INSERT INTO browser_platform_automation_policies(
      id,tenant_id,workspace_id,project_id,account_id,platform_code,
      enabled,daily_enabled,created_by
    ) VALUES(
      ${POLICY_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
      ${ACCOUNT_ID}::uuid,'sohu',true,true,${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO browser_platform_automation_runs(
      id,tenant_id,policy_id,platform_code,variant_id,content_version_id,
      status,publish_job_id
    ) VALUES(
      ${AUTOMATION_RUN_ID}::uuid,${TENANT_ID}::uuid,${POLICY_ID}::uuid,'sohu',
      ${VARIANT_ID}::uuid,${VERSION_ID}::uuid,'scheduled',${JOB_ID}::uuid
    )
  `;
  await database`
    INSERT INTO browser_platform_daily_batches(
      id,tenant_id,policy_id,business_date,status,scheduled_at
    ) VALUES(
      ${DAILY_BATCH_ID}::uuid,${TENANT_ID}::uuid,${POLICY_ID}::uuid,
      DATE '2026-08-16','scheduled',now()
    )
  `;
  await database`
    INSERT INTO browser_platform_daily_batch_items(
      id,tenant_id,batch_id,candidate_no,automation_run_id,brief_id,package_id,
      variant_id,content_version_id,publish_job_id,status,qualified_at,scheduled_at
    ) VALUES(
      ${DAILY_ITEM_ID}::uuid,${TENANT_ID}::uuid,${DAILY_BATCH_ID}::uuid,1,
      ${AUTOMATION_RUN_ID}::uuid,${BRIEF_ID}::uuid,${PACKAGE_ID}::uuid,
      ${VARIANT_ID}::uuid,${VERSION_ID}::uuid,${JOB_ID}::uuid,
      'scheduled',now(),now()
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
    INSERT INTO workspaces(id,tenant_id,name,slug,timezone,status,settings_json)
    VALUES(
      ${WORKSPACE_ID}::uuid,${TENANT_ID}::uuid,'Publishing','publishing-125',
      'Asia/Shanghai','active',
      '{"schema_version":"workspace-settings@1","official_site_service_phone":"02085627757"}'::jsonb
    )
  `;
  await database`
    INSERT INTO workspace_memberships(workspace_id,user_id,scope_json)
    VALUES(${WORKSPACE_ID}::uuid,${USER_ID}::uuid,'{}'::jsonb)
  `;
  await database`
    INSERT INTO brand_profiles(
      tenant_id,workspace_id,version,status,schema_version,profile_json,created_by,published_at
    ) VALUES(
      ${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,1,'published','brand-profile@1',
      ${database.json({
        audience: ['广州搬家用户'],
        banned: ['未经证实的价格和排名'],
        compliance: ['只使用可核验事实'],
        cta: `联系${OWNER_COMPANY_NAME}获取搬迁方案`,
        differentiators: ['本地搬迁服务经验'],
        positioning: `${OWNER_COMPANY_NAME}面向广州提供搬迁服务。`,
        tone: '专业、直接、实用',
      })},
      ${USER_ID}::uuid,now()
    )
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
