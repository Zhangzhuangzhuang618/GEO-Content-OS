import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import {
  PublishJobService,
  type PublishJobScope,
} from '../../src/modules/publishing/jobs/index.js';
import { PublishingApiService } from '../../src/modules/publishing/api/publishing-api.service.js';

const USER_ID = '11000000-0000-4000-8000-000000000124';
const OTHER_USER_ID = '12000000-0000-4000-8000-000000000124';
const TENANT_ID = '21000000-0000-4000-8000-000000000124';
const WORKSPACE_ID = '31000000-0000-4000-8000-000000000124';
const OTHER_WORKSPACE_ID = '32000000-0000-4000-8000-000000000124';
const PROJECT_ID = '41000000-0000-4000-8000-000000000124';
const BRIEF_ID = '51000000-0000-4000-8000-000000000124';
const PACKAGE_ID = '61000000-0000-4000-8000-000000000124';
const VARIANT_ID = '71000000-0000-4000-8000-000000000124';
const VERSION_ID = '81000000-0000-4000-8000-000000000124';
const ACCOUNT_ID = '91000000-0000-4000-8000-000000000124';
const AUTO_JOB_ID = 'a1000000-0000-4000-8000-000000000124';
const POLICY_ID = 'a2000000-0000-4000-8000-000000000124';
const AUTOMATION_RUN_ID = 'a3000000-0000-4000-8000-000000000124';
const BROWSER_SESSION_ID = 'a4000000-0000-4000-8000-000000000124';
const BROWSER_PUBLICATION_ID = 'a5000000-0000-4000-8000-000000000124';
const BAIJIAHAO_BATCH_ID = 'a6000000-0000-4000-8000-000000000124';
const BAIJIAHAO_BATCH_ITEM_ID = 'a7000000-0000-4000-8000-000000000124';
const CONTENT_HASH = 'a'.repeat(64);
const SCHEDULED_AT = '2027-01-02T03:04:05.000Z';

const SCOPE: PublishJobScope = {
  requestId: 'req-publish-job-124',
  tenantId: TENANT_ID,
  userId: USER_ID,
};
const OTHER_SCOPE: PublishJobScope = {
  requestId: 'req-publish-job-other-124',
  tenantId: TENANT_ID,
  userId: OTHER_USER_ID,
};

describe('publish jobs', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;

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
        content_versions, content_variants, content_packages, briefs, workspace_memberships,
        projects, workspaces, audit_events, outbox_events, memberships, tenants, users
      CASCADE
    `;
    await seed(database);
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('schedules only the approved current version and freezes its payload hash', async () => {
    const database = requireClient(client);
    const service = new PublishJobService(database);
    const job = await service.create(
      SCOPE,
      { account_id: ACCOUNT_ID, scheduled_at: SCHEDULED_AT, variant_id: VARIANT_ID },
      'publish-job-124',
    );

    expect(job).toMatchObject({
      account_id: ACCOUNT_ID,
      content_version_id: VERSION_ID,
      payload_hash: CONTENT_HASH,
      scheduled_at: SCHEDULED_AT,
      status: 'scheduled',
      variant_id: VARIANT_ID,
      version: 1,
    });
    await expect(contentState(database)).resolves.toEqual({
      packageStatus: 'scheduled',
      variantStatus: 'scheduled',
      variantVersion: 2,
    });
    const events = await database<
      { aggregate_id: string; data: Record<string, unknown>; next_attempt_at: Date }[]
    >`
      SELECT aggregate_id, payload_json->'data' AS data, next_attempt_at
      FROM outbox_events WHERE aggregate_id=${job.id}::uuid
    `;
    expect(events[0]).toMatchObject({
      aggregate_id: job.id,
      data: { job_id: job.id, job_version: 1, scheduled_at: SCHEDULED_AT },
      next_attempt_at: new Date(SCHEDULED_AT),
    });
    await expect(auditActions(database, job.id)).resolves.toEqual(['publish_job.scheduled']);

    await expect(
      service.create(
        { ...SCOPE, requestId: 'req-publish-job-repeat-124' },
        { account_id: ACCOUNT_ID, scheduled_at: SCHEDULED_AT, variant_id: VARIANT_ID },
        'publish-job-repeat-124',
      ),
    ).rejects.toMatchObject({ code: 'PUBLISH_JOB_STATE_INVALID' });
  });

  it('cancels before the platform call and restores the approved variant', async () => {
    const database = requireClient(client);
    const service = new PublishJobService(database);
    const job = await schedule(service);
    const cancelled = await service.cancel(
      { ...SCOPE, requestId: 'req-publish-cancel-124' },
      job.id,
      1,
      'Campaign stopped',
    );

    expect(cancelled).toMatchObject({ status: 'cancelled', version: 2 });
    await expect(contentState(database)).resolves.toEqual({
      packageStatus: 'approved',
      variantStatus: 'approved',
      variantVersion: 3,
    });
    await expect(auditActions(database, job.id)).resolves.toEqual([
      'publish_job.scheduled',
      'publish_job.cancelled',
    ]);
    await expect(service.cancel(SCOPE, job.id, 1, 'stale cancellation')).rejects.toMatchObject({
      code: 'PUBLISH_JOB_VERSION_CONFLICT',
    });
  });

  it('rejects non-approved variants and unavailable account capabilities atomically', async () => {
    const database = requireClient(client);
    const service = new PublishJobService(database);
    await database`
      UPDATE content_variants SET status='quality_passed' WHERE id=${VARIANT_ID}::uuid
    `;
    await expect(schedule(service)).rejects.toMatchObject({
      code: 'PUBLISH_JOB_STATE_INVALID',
    });

    await database`
      UPDATE content_variants SET status='approved' WHERE id=${VARIANT_ID}::uuid
    `;
    await database`
      UPDATE platform_accounts SET capabilities_json=${database.json({
        export: true,
        publish: false,
      })} WHERE id=${ACCOUNT_ID}::uuid
    `;
    await expect(schedule(service)).rejects.toMatchObject({
      code: 'PUBLISH_CAPABILITY_UNAVAILABLE',
    });
    const writes = await database<{ jobs: number; outbox: number }[]>`
      SELECT
        (SELECT count(*)::integer FROM publish_jobs) AS jobs,
        (SELECT count(*)::integer FROM outbox_events) AS outbox
    `;
    expect(writes).toEqual([{ jobs: 0, outbox: 0 }]);
  });

  it('treats publishing state as a started platform call before its final attempt is appended', async () => {
    const database = requireClient(client);
    const service = new PublishJobService(database);
    const job = await schedule(service);
    await markPublishing(database, job.id);

    const cancelled = await service.cancel(
      { ...SCOPE, requestId: 'req-publish-cancel-running-124' },
      job.id,
      2,
      'Stop if supported',
    );
    expect(cancelled).toMatchObject({ status: 'cancel_requested', version: 3 });
    await expect(contentState(database)).resolves.toMatchObject({
      packageStatus: 'publishing',
      variantStatus: 'publishing',
    });
  });

  it('retries a conclusive failure without changing the frozen content or payload', async () => {
    const database = requireClient(client);
    const service = new PublishJobService(database);
    const job = await schedule(service);
    await markFailed(database, job.id, 'failed');

    const retried = await service.retry(
      { ...SCOPE, requestId: 'req-publish-retry-124' },
      job.id,
      2,
      { scheduled_at: SCHEDULED_AT },
    );
    expect(retried).toMatchObject({
      attempt_count: 1,
      content_version_id: VERSION_ID,
      payload_hash: CONTENT_HASH,
      scheduled_at: SCHEDULED_AT,
      status: 'scheduled',
      version: 3,
    });
    await expect(contentState(database)).resolves.toEqual({
      packageStatus: 'scheduled',
      variantStatus: 'scheduled',
      variantVersion: 5,
    });
    const eventCount = await database<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM outbox_events WHERE aggregate_id=${job.id}::uuid
    `;
    expect(eventCount).toEqual([{ count: 2 }]);
  });

  it('blocks blind retry of unknown external state and hides other workspace scope', async () => {
    const database = requireClient(client);
    const service = new PublishJobService(database);
    await expect(
      service.create(
        OTHER_SCOPE,
        { account_id: ACCOUNT_ID, scheduled_at: SCHEDULED_AT, variant_id: VARIANT_ID },
        'publish-job-denied-124',
      ),
    ).rejects.toMatchObject({ code: 'PUBLISH_JOB_NOT_FOUND' });

    const job = await schedule(service);
    await markFailed(database, job.id, 'unknown');
    await expect(
      service.retry(SCOPE, job.id, 2, { scheduled_at: SCHEDULED_AT }),
    ).rejects.toMatchObject({ code: 'PUBLISH_JOB_STATE_INVALID' });
    const state = await database<{ status: string; version: number }[]>`
      SELECT status,version FROM publish_jobs WHERE id=${job.id}::uuid
    `;
    expect(state).toEqual([{ status: 'failed', version: 2 }]);
  });

  it('resets a verified missing Baijiahao publication and requeues without changing its unknown attempt', async () => {
    const database = requireClient(client);
    const service = new PublishJobService(database);
    const job = await seedBaijiahaoUnknown(database, service);

    const resolved = await service.resolveUnknown(
      { ...SCOPE, requestId: 'req-baijiahao-not-published-124' },
      job.id,
      2,
      { resolution: 'not_published' },
    );

    expect(resolved).toMatchObject({ attempt_count: 1, status: 'scheduled', version: 3 });
    const publications = await database<
      { externalPostId: string | null; status: string; submittedAt: Date | null }[]
    >`
      SELECT status,external_post_id AS "externalPostId",submitted_at AS "submittedAt"
      FROM baijiahao_browser_publications WHERE id=${BROWSER_PUBLICATION_ID}::uuid
    `;
    expect(publications).toEqual([{ externalPostId: null, status: 'prepared', submittedAt: null }]);
    const attempts = await database<{ attemptNo: number; status: string }[]>`
      SELECT attempt_no AS "attemptNo",status FROM publish_attempts
      WHERE publish_job_id=${job.id}::uuid ORDER BY attempt_no
    `;
    expect(attempts).toEqual([{ attemptNo: 1, status: 'unknown' }]);
    await expect(auditActions(database, job.id)).resolves.toContain(
      'publish_job.unknown_resolved_not_published',
    );
  });

  it('records a verified Baijiahao article as published while preserving the unknown attempt', async () => {
    const database = requireClient(client);
    const service = new PublishJobService(database);
    const job = await seedBaijiahaoUnknown(database, service);

    const resolved = await service.resolveUnknown(
      { ...SCOPE, requestId: 'req-baijiahao-published-124' },
      job.id,
      2,
      {
        external_post_id: 'baijiahao-post-124',
        external_url: 'https://baijiahao.baidu.com/s?id=124',
        resolution: 'published',
      },
    );

    expect(resolved).toMatchObject({
      external_post_id: 'baijiahao-post-124',
      external_url: 'https://baijiahao.baidu.com/s?id=124',
      status: 'published',
      version: 3,
    });
    await expect(contentState(database)).resolves.toMatchObject({
      packageStatus: 'published',
      variantStatus: 'published',
    });
    const publication = await database<{ externalPostId: string; status: string }[]>`
      SELECT status,external_post_id AS "externalPostId"
      FROM baijiahao_browser_publications WHERE id=${BROWSER_PUBLICATION_ID}::uuid
    `;
    expect(publication).toEqual([{ externalPostId: 'baijiahao-post-124', status: 'published' }]);
    const attempts = await database<{ status: string }[]>`
      SELECT status FROM publish_attempts WHERE publish_job_id=${job.id}::uuid
    `;
    expect(attempts).toEqual([{ status: 'unknown' }]);
    await expect(auditActions(database, job.id)).resolves.toContain(
      'publish_job.unknown_resolved_published',
    );
  });

  it('allows manual completion of an unverified Lieju official API success', async () => {
    const database = requireClient(client);
    const service = new PublishJobService(database);
    await database`UPDATE briefs SET platform_codes=ARRAY['lieju']::varchar[] WHERE id=${BRIEF_ID}::uuid`;
    await database`
      UPDATE platform_accounts SET platform_code='lieju',display_name='Lieju Official API',
        capabilities_json=${database.json({ delivery_method: 'official_api', publish: true })}
      WHERE id=${ACCOUNT_ID}::uuid
    `;
    await database`
      UPDATE content_variants SET platform_code='lieju' WHERE id=${VARIANT_ID}::uuid
    `;
    const job = await schedule(service);
    await database.begin(async (transaction) => {
      await transaction`
        UPDATE publish_jobs SET status='publishing',attempt_count=1,
          external_post_id='api-lieju-124',version=2 WHERE id=${job.id}::uuid
      `;
      await transaction`
        UPDATE content_variants SET status='publishing',version=3 WHERE id=${VARIANT_ID}::uuid
      `;
      await transaction`
        UPDATE content_packages SET status='publishing',version=3 WHERE id=${PACKAGE_ID}::uuid
      `;
      await transaction`
        INSERT INTO publish_attempts(
          tenant_id,publish_job_id,attempt_no,adapter_code,status,request_hash,
          response_json,started_at,finished_at
        ) VALUES(
          ${TENANT_ID}::uuid,${job.id}::uuid,1,'lieju-delivery@1.2.0','succeeded',
          ${'b'.repeat(64)},${transaction.json({ status: 'processing' })},now(),now()
        )
      `;
      await transaction`
        INSERT INTO lieju_api_publications(
          id,tenant_id,account_id,publish_job_id,content_version_id,idempotency_key,
          payload_hash,attempt_no,status,remote_reference,submitted_at
        ) VALUES(
          ${BROWSER_PUBLICATION_ID}::uuid,${TENANT_ID}::uuid,${ACCOUNT_ID}::uuid,
          ${job.id}::uuid,${VERSION_ID}::uuid,${job.idempotency_key},${CONTENT_HASH},1,
          'processing','api-lieju-124',now()
        )
      `;
    });

    const detail = await new PublishingApiService(database, {} as ObjectStorageAdapter).detail(
      SCOPE,
      job.id,
    );
    expect(detail.unknown_resolution).toMatchObject({
      latest_attempt_no: 1,
      platform_code: 'lieju',
    });
    const resolved = await service.resolveUnknown(
      { ...SCOPE, requestId: 'req-lieju-official-published-124' },
      job.id,
      2,
      {
        external_post_id: 'api-lieju-124',
        external_url: 'https://gz.lieju.com/banjia/104561172.html',
        resolution: 'published',
      },
    );

    expect(resolved).toMatchObject({ status: 'published', version: 3 });
    expect(
      await database<{ status: string }[]>`
        SELECT status FROM lieju_api_publications WHERE id=${BROWSER_PUBLICATION_ID}::uuid
      `,
    ).toEqual([{ status: 'published' }]);
  });

  it('requeues only terminal Baijiahao reconciliation for a stuck publishing job', async () => {
    const database = requireClient(client);
    const service = new PublishJobService(database);
    const job = await seedBaijiahaoPublishingTerminal(database, service, 'published');

    const detail = await new PublishingApiService(database, {} as ObjectStorageAdapter).detail(
      SCOPE,
      job.id,
    );
    expect(detail.baijiahao_reconciliation).toEqual({ platform_code: 'baijiahao' });

    const requested = await service.requestBaijiahaoReconciliation(
      { ...SCOPE, requestId: 'req-baijiahao-reconcile-124' },
      job.id,
      2,
    );

    expect(requested).toMatchObject({
      external_post_id: 'baijiahao-terminal-124',
      status: 'publishing',
      version: 3,
    });
    const events = await database<
      { eventType: string; jobVersion: number | null; reconcileAttempt: number | null }[]
    >`
      SELECT event_type AS "eventType",
        (payload_json->'data'->>'job_version')::integer AS "jobVersion",
        (payload_json->'data'->>'reconcile_attempt')::integer AS "reconcileAttempt"
      FROM outbox_events WHERE aggregate_id=${job.id}::uuid ORDER BY created_at,id
    `;
    expect(events).toEqual([
      {
        eventType: 'publishing.job.execution_requested.v1',
        jobVersion: 1,
        reconcileAttempt: null,
      },
      {
        eventType: 'baijiahao.publication.reconcile_requested.v1',
        jobVersion: 3,
        reconcileAttempt: 1,
      },
    ]);
    await expect(auditActions(database, job.id)).resolves.toContain(
      'publish_job.reconciliation_requested',
    );
  });

  it('does not requeue a nonterminal Baijiahao browser publication', async () => {
    const database = requireClient(client);
    const service = new PublishJobService(database);
    const job = await seedBaijiahaoPublishingTerminal(database, service, 'processing');

    const detail = await new PublishingApiService(database, {} as ObjectStorageAdapter).detail(
      SCOPE,
      job.id,
    );
    expect(detail.baijiahao_reconciliation).toBeNull();

    await expect(service.requestBaijiahaoReconciliation(SCOPE, job.id, 2)).rejects.toMatchObject({
      code: 'PUBLISH_JOB_STATE_INVALID',
    });
    const events = await database<{ eventType: string }[]>`
      SELECT event_type AS "eventType" FROM outbox_events
      WHERE aggregate_id=${job.id}::uuid ORDER BY created_at,id
    `;
    expect(events).toEqual([{ eventType: 'publishing.job.execution_requested.v1' }]);
  });

  it('requires verification and atomically restores a manual-required Baijiahao automation', async () => {
    const database = requireClient(client);
    const service = new PublishJobService(database);
    const job = await seedBaijiahaoManualRequired(database);

    const detail = await new PublishingApiService(database, {} as ObjectStorageAdapter).detail(
      SCOPE,
      job.id,
    );
    expect(detail.unknown_resolution).toEqual({
      blocked_reason: null,
      can_retry: true,
      latest_attempt_no: 2,
      platform_code: 'baijiahao',
    });

    await expect(
      service.retry(SCOPE, job.id, 3, { scheduled_at: SCHEDULED_AT }),
    ).rejects.toMatchObject({ code: 'PUBLISH_JOB_STATE_INVALID' });

    const resolved = await service.resolveUnknown(
      { ...SCOPE, requestId: 'req-baijiahao-manual-not-published-124' },
      job.id,
      3,
      { resolution: 'not_published' },
    );

    expect(resolved).toMatchObject({ attempt_count: 2, status: 'scheduled', version: 4 });
    const states = await database<
      {
        automationError: Record<string, unknown> | null;
        automationFinishedAt: Date | null;
        automationStatus: string;
        itemError: Record<string, unknown> | null;
        itemStatus: string;
        publicationStatus: string;
        submittedAt: Date | null;
      }[]
    >`
      SELECT automation.status AS "automationStatus",
        automation.last_error_json AS "automationError",
        automation.finished_at AS "automationFinishedAt",
        item.status AS "itemStatus",item.last_error_json AS "itemError",
        publication.status AS "publicationStatus",publication.submitted_at AS "submittedAt"
      FROM baijiahao_automation_runs AS automation
      JOIN baijiahao_daily_batch_items AS item
        ON item.automation_run_id=automation.id AND item.tenant_id=automation.tenant_id
      JOIN baijiahao_browser_publications AS publication
        ON publication.publish_job_id=automation.publish_job_id
        AND publication.tenant_id=automation.tenant_id
      WHERE automation.id=${AUTOMATION_RUN_ID}::uuid
    `;
    expect(states).toEqual([
      {
        automationError: null,
        automationFinishedAt: null,
        automationStatus: 'scheduled',
        itemError: null,
        itemStatus: 'scheduled',
        publicationStatus: 'prepared',
        submittedAt: null,
      },
    ]);
    const attempts = await database<{ errorCode: string; status: string }[]>`
      SELECT status,error_code AS "errorCode" FROM publish_attempts
      WHERE publish_job_id=${job.id}::uuid ORDER BY attempt_no
    `;
    expect(attempts).toEqual([
      { errorCode: 'PUBLISH_STATE_UNKNOWN', status: 'unknown' },
      { errorCode: 'MANUAL_REQUIRED', status: 'failed' },
    ]);
  });

  it('restores a Lieju official automation after its unknown result is verified as not published', async () => {
    const database = requireClient(client);
    const service = new PublishJobService(database);
    const job = await seedLiejuOfficialUnknownAutomation(database);

    const detail = await new PublishingApiService(database, {} as ObjectStorageAdapter).detail(
      SCOPE,
      job.id,
    );
    expect(detail.unknown_resolution).toEqual({
      blocked_reason: null,
      can_retry: true,
      latest_attempt_no: 2,
      platform_code: 'lieju',
    });

    await expect(
      service.retry(SCOPE, job.id, 3, { scheduled_at: SCHEDULED_AT }),
    ).rejects.toMatchObject({ code: 'PUBLISH_JOB_STATE_INVALID' });

    const resolved = await service.resolveUnknown(
      { ...SCOPE, requestId: 'req-lieju-official-unknown-not-published-124' },
      job.id,
      3,
      { resolution: 'not_published' },
    );

    expect(resolved).toMatchObject({ attempt_count: 2, status: 'scheduled', version: 4 });
    const states = await database<
      {
        automationError: Record<string, unknown> | null;
        automationFinishedAt: Date | null;
        automationStatus: string;
        itemError: Record<string, unknown> | null;
        itemStatus: string;
        publicationAttemptNo: number;
        publicationError: Record<string, unknown> | null;
        publicationResponseHash: string | null;
        publicationStatus: string;
        submittedAt: Date | null;
      }[]
    >`
      SELECT automation.status AS "automationStatus",
        automation.last_error_json AS "automationError",
        automation.finished_at AS "automationFinishedAt",
        item.status AS "itemStatus",item.last_error_json AS "itemError",
        publication.status AS "publicationStatus",
        publication.attempt_no AS "publicationAttemptNo",
        publication.last_error_json AS "publicationError",
        publication.response_hash AS "publicationResponseHash",
        publication.submitted_at AS "submittedAt"
      FROM browser_platform_automation_runs AS automation
      JOIN browser_platform_daily_batch_items AS item
        ON item.automation_run_id=automation.id AND item.tenant_id=automation.tenant_id
      JOIN lieju_api_publications AS publication
        ON publication.publish_job_id=automation.publish_job_id
        AND publication.tenant_id=automation.tenant_id
      WHERE automation.id=${AUTOMATION_RUN_ID}::uuid
    `;
    expect(states).toEqual([
      {
        automationError: null,
        automationFinishedAt: null,
        automationStatus: 'scheduled',
        itemError: null,
        itemStatus: 'scheduled',
        publicationAttemptNo: 2,
        publicationError: null,
        publicationResponseHash: null,
        publicationStatus: 'not_published',
        submittedAt: null,
      },
    ]);
    const attempts = await database<{ attemptNo: number; errorCode: string; status: string }[]>`
      SELECT attempt_no AS "attemptNo",status,error_code AS "errorCode"
      FROM publish_attempts WHERE publish_job_id=${job.id}::uuid ORDER BY attempt_no
    `;
    expect(attempts).toEqual([
      { attemptNo: 1, errorCode: 'PUBLISHER_RENDER_BLOCKED', status: 'failed' },
      { attemptNo: 2, errorCode: 'PUBLISH_STATE_UNKNOWN', status: 'unknown' },
    ]);
    const events = await database<{ eventType: string }[]>`
      SELECT event_type AS "eventType" FROM outbox_events
      WHERE aggregate_id=${job.id}::uuid ORDER BY created_at,id
    `;
    expect(events).toEqual([{ eventType: 'publishing.job.execution_requested.v1' }]);
    await expect(auditActions(database, job.id)).resolves.toContain(
      'publish_job.unknown_resolved_not_published',
    );
  });

  it('closes an exhausted Baijiahao automation verified as not published', async () => {
    const database = requireClient(client);
    const service = new PublishJobService(database);
    const job = await seedBaijiahaoManualRequired(database, 3);

    const detail = await new PublishingApiService(database, {} as ObjectStorageAdapter).detail(
      SCOPE,
      job.id,
    );
    expect(detail.unknown_resolution).toEqual({
      blocked_reason: null,
      can_retry: false,
      latest_attempt_no: 3,
      platform_code: 'baijiahao',
    });

    const resolved = await service.resolveUnknown(
      { ...SCOPE, requestId: 'req-baijiahao-not-published-closed-124' },
      job.id,
      3,
      { resolution: 'not_published_closed' },
    );

    expect(resolved).toMatchObject({ attempt_count: 3, status: 'cancelled', version: 4 });
    const states = await database<
      {
        automationStatus: string;
        itemStatus: string;
        jobStatus: string;
        publicationStatus: string;
        variantStatus: string;
      }[]
    >`
      SELECT automation.status AS "automationStatus",item.status AS "itemStatus",
        job.status AS "jobStatus",publication.status AS "publicationStatus",
        variant.status AS "variantStatus"
      FROM baijiahao_automation_runs AS automation
      JOIN baijiahao_daily_batch_items AS item
        ON item.automation_run_id=automation.id AND item.tenant_id=automation.tenant_id
      JOIN publish_jobs AS job
        ON job.id=automation.publish_job_id AND job.tenant_id=automation.tenant_id
      JOIN content_variants AS variant
        ON variant.id=automation.variant_id AND variant.tenant_id=automation.tenant_id
      JOIN baijiahao_browser_publications AS publication
        ON publication.publish_job_id=job.id AND publication.tenant_id=job.tenant_id
      WHERE automation.id=${AUTOMATION_RUN_ID}::uuid
    `;
    expect(states).toEqual([
      {
        automationStatus: 'disabled',
        itemStatus: 'retired',
        jobStatus: 'cancelled',
        publicationStatus: 'failed',
        variantStatus: 'quality_passed',
      },
    ]);
    const attempts = await database<{ attemptNo: number; status: string }[]>`
      SELECT attempt_no AS "attemptNo",status FROM publish_attempts
      WHERE publish_job_id=${job.id}::uuid ORDER BY attempt_no
    `;
    expect(attempts).toEqual([
      { attemptNo: 1, status: 'unknown' },
      { attemptNo: 3, status: 'failed' },
    ]);
    await expect(auditActions(database, job.id)).resolves.toContain(
      'publish_job.unknown_resolved_not_published_closed',
    );
  });

  it('cancels and restores a queued website automation without replacing its job', async () => {
    const database = requireClient(client);
    await seedAutomationJob(database, 'scheduled', 0);
    const service = new PublishJobService(database);

    const cancelled = await service.cancel(
      { ...SCOPE, requestId: 'req-auto-cancel-124' },
      AUTO_JOB_ID,
      1,
      'Stop website automation',
    );

    expect(cancelled).toMatchObject({ origin: 'official_site_automation', status: 'cancelled' });
    await expect(automationState(database)).resolves.toMatchObject({
      automationStatus: 'disabled',
      jobStatus: 'cancelled',
      variantStatus: 'quality_passed',
    });

    const rescheduled = await service.retry(
      { ...SCOPE, requestId: 'req-auto-reschedule-124' },
      AUTO_JOB_ID,
      cancelled.version,
      { scheduled_at: SCHEDULED_AT },
    );

    expect(rescheduled).toMatchObject({
      id: AUTO_JOB_ID,
      origin: 'official_site_automation',
      scheduled_at: SCHEDULED_AT,
      status: 'scheduled',
      version: 3,
    });
    await expect(automationState(database)).resolves.toMatchObject({
      automationStatus: 'publishing',
      jobStatus: 'scheduled',
      variantStatus: 'scheduled',
    });
  });

  it('retries a conclusive website automation failure and enforces the three-attempt limit', async () => {
    const database = requireClient(client);
    await seedAutomationJob(database, 'failed', 1);
    const service = new PublishJobService(database);

    const retried = await service.retry(
      { ...SCOPE, requestId: 'req-auto-retry-124' },
      AUTO_JOB_ID,
      1,
      { scheduled_at: SCHEDULED_AT },
    );
    expect(retried).toMatchObject({
      attempt_count: 1,
      origin: 'official_site_automation',
      status: 'scheduled',
      version: 2,
    });
    await expect(automationState(database)).resolves.toMatchObject({
      automationStatus: 'publishing',
      jobStatus: 'scheduled',
      variantStatus: 'scheduled',
    });

    await database`
      UPDATE publish_jobs SET status='failed',attempt_count=3,version=version+1
      WHERE id=${AUTO_JOB_ID}::uuid
    `;
    await database`
      UPDATE content_variants SET status='publish_failed',version=version+1
      WHERE id=${VARIANT_ID}::uuid
    `;
    await database`
      UPDATE content_packages SET status='publish_failed',version=version+1
      WHERE id=${PACKAGE_ID}::uuid
    `;
    await database`
      UPDATE official_site_automation_runs SET status='publish_failed',finished_at=now(),version=version+1
      WHERE id=${AUTOMATION_RUN_ID}::uuid
    `;
    await expect(
      service.retry(SCOPE, AUTO_JOB_ID, 3, { scheduled_at: SCHEDULED_AT }),
    ).rejects.toMatchObject({ code: 'PUBLISH_JOB_STATE_INVALID' });
  });
});

async function schedule(service: PublishJobService) {
  return service.create(
    SCOPE,
    { account_id: ACCOUNT_ID, scheduled_at: SCHEDULED_AT, variant_id: VARIANT_ID },
    'publish-job-124',
  );
}

async function markPublishing(database: Sql, jobId: string): Promise<void> {
  await database.begin(async (transaction) => {
    await transaction`
      UPDATE publish_jobs SET status='publishing',attempt_count=1,version=version+1
      WHERE id=${jobId}::uuid
    `;
    await transaction`
      UPDATE content_variants SET status='publishing',version=version+1
      WHERE id=${VARIANT_ID}::uuid
    `;
    await transaction`
      UPDATE content_packages SET status='publishing',version=version+1
      WHERE id=${PACKAGE_ID}::uuid
    `;
  });
}

async function markFailed(
  database: Sql,
  jobId: string,
  attemptStatus: 'failed' | 'unknown',
  adapterCode = 'official-site@1',
): Promise<void> {
  await database.begin(async (transaction) => {
    await transaction`
      UPDATE publish_jobs SET
        status='failed',attempt_count=1,last_error_json=${transaction.json({
          code: attemptStatus === 'unknown' ? 'PUBLISH_STATE_UNKNOWN' : 'PUBLISH_REJECTED',
          schema_version: 'adapter-error@1',
        })},version=version+1
      WHERE id=${jobId}::uuid
    `;
    await transaction`
      UPDATE content_variants SET status='publish_failed',version=version+1
      WHERE id=${VARIANT_ID}::uuid
    `;
    await transaction`
      UPDATE content_packages SET status='publish_failed',version=version+1
      WHERE id=${PACKAGE_ID}::uuid
    `;
    await transaction`
      INSERT INTO publish_attempts(
        tenant_id,publish_job_id,attempt_no,adapter_code,status,request_hash,
        error_code,started_at,finished_at
      ) VALUES (
        ${TENANT_ID}::uuid,${jobId}::uuid,1,${adapterCode},${attemptStatus},
        ${'b'.repeat(64)},
        ${attemptStatus === 'unknown' ? 'PUBLISH_STATE_UNKNOWN' : 'PUBLISH_REJECTED'},now(),now()
      )
    `;
  });
}

async function seedBaijiahaoUnknown(database: Sql, service: PublishJobService) {
  await database`
    UPDATE briefs SET platform_codes=ARRAY['baijiahao']::varchar[] WHERE id=${BRIEF_ID}::uuid
  `;
  await database`
    UPDATE content_variants SET platform_code='baijiahao' WHERE id=${VARIANT_ID}::uuid
  `;
  await database`
    UPDATE platform_accounts SET platform_code='baijiahao',display_name='Baijiahao'
    WHERE id=${ACCOUNT_ID}::uuid
  `;
  const job = await schedule(service);
  await markFailed(database, job.id, 'unknown', 'baijiahao-delivery@1.1.0');
  await database`
    INSERT INTO baijiahao_browser_sessions(
      id,tenant_id,account_id,status,profile_key,authenticated_at,last_verified_at
    ) VALUES(
      ${BROWSER_SESSION_ID}::uuid,${TENANT_ID}::uuid,${ACCOUNT_ID}::uuid,'authenticated',
      'baijiahao/test/account-124',now(),now()
    )
  `;
  await database`
    INSERT INTO baijiahao_browser_publications(
      id,tenant_id,session_id,account_id,publish_job_id,content_version_id,
      idempotency_key,payload_hash,content_fingerprint,title,status,submitted_at
    ) VALUES(
      ${BROWSER_PUBLICATION_ID}::uuid,${TENANT_ID}::uuid,${BROWSER_SESSION_ID}::uuid,
      ${ACCOUNT_ID}::uuid,${job.id}::uuid,${VERSION_ID}::uuid,${job.idempotency_key},
      ${CONTENT_HASH},${'b'.repeat(64)},'百家号未知发布测试','submitting',now()
    )
  `;
  return job;
}

async function seedBaijiahaoPublishingTerminal(
  database: Sql,
  service: PublishJobService,
  publicationStatus: 'failed' | 'processing' | 'published',
) {
  await database`
    UPDATE briefs SET platform_codes=ARRAY['baijiahao']::varchar[] WHERE id=${BRIEF_ID}::uuid
  `;
  await database`
    UPDATE content_variants SET platform_code='baijiahao' WHERE id=${VARIANT_ID}::uuid
  `;
  await database`
    UPDATE platform_accounts SET platform_code='baijiahao',display_name='Baijiahao'
    WHERE id=${ACCOUNT_ID}::uuid
  `;
  const job = await schedule(service);
  await database.begin(async (transaction) => {
    await transaction`
      UPDATE publish_jobs SET status='publishing',attempt_count=1,
        external_post_id='baijiahao-terminal-124',
        external_url='https://baijiahao.baidu.com/builder/preview/s?id=124',version=2
      WHERE id=${job.id}::uuid
    `;
    await transaction`
      UPDATE content_variants SET status='publishing',version=3 WHERE id=${VARIANT_ID}::uuid
    `;
    await transaction`
      UPDATE content_packages SET status='publishing',version=3 WHERE id=${PACKAGE_ID}::uuid
    `;
    await transaction`
      INSERT INTO publish_attempts(
        tenant_id,publish_job_id,attempt_no,adapter_code,status,request_hash,
        response_json,started_at,finished_at
      ) VALUES(
        ${TENANT_ID}::uuid,${job.id}::uuid,1,'baijiahao-delivery@1.1.0','succeeded',
        ${'b'.repeat(64)},${transaction.json({
          external_id: 'baijiahao-terminal-124',
          status: 'processing',
        })},now(),now()
      )
    `;
    await transaction`
      INSERT INTO baijiahao_browser_sessions(
        id,tenant_id,account_id,status,profile_key,authenticated_at,last_verified_at
      ) VALUES(
        ${BROWSER_SESSION_ID}::uuid,${TENANT_ID}::uuid,${ACCOUNT_ID}::uuid,'authenticated',
        'baijiahao/test/account-124',now(),now()
      )
    `;
    await transaction`
      INSERT INTO baijiahao_browser_publications(
        id,tenant_id,session_id,account_id,publish_job_id,content_version_id,
        idempotency_key,payload_hash,content_fingerprint,title,status,external_post_id,
        external_url,submitted_at,last_reconciled_at
      ) VALUES(
        ${BROWSER_PUBLICATION_ID}::uuid,${TENANT_ID}::uuid,${BROWSER_SESSION_ID}::uuid,
        ${ACCOUNT_ID}::uuid,${job.id}::uuid,${VERSION_ID}::uuid,${job.idempotency_key},
        ${CONTENT_HASH},${'b'.repeat(64)},'百家号终态重新核验测试',${publicationStatus},
        'baijiahao-terminal-124','https://baijiahao.baidu.com/s?id=124',now(),now()
      )
    `;
  });
  return job;
}

async function seedBaijiahaoManualRequired(database: Sql, latestAttemptNo = 2) {
  const error = {
    code: 'MANUAL_REQUIRED',
    message: 'Baijiahao browser publication requires manual handling',
    schema_version: 'adapter-error@1',
  };
  await database.begin(async (transaction) => {
    await transaction`
      UPDATE briefs SET platform_codes=ARRAY['baijiahao']::varchar[] WHERE id=${BRIEF_ID}::uuid
    `;
    await transaction`
      UPDATE platform_accounts SET platform_code='baijiahao',display_name='Baijiahao'
      WHERE id=${ACCOUNT_ID}::uuid
    `;
    await transaction`
      UPDATE content_variants SET platform_code='baijiahao',platform_account_id=${ACCOUNT_ID}::uuid,
        status='publish_failed',version=3
      WHERE id=${VARIANT_ID}::uuid
    `;
    await transaction`
      UPDATE content_packages SET status='publish_failed',version=2
      WHERE id=${PACKAGE_ID}::uuid
    `;
    await transaction`
      INSERT INTO baijiahao_automation_policies(
        id,tenant_id,workspace_id,project_id,account_id,enabled,source_mode,created_by
      ) VALUES(
        ${POLICY_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
        ${ACCOUNT_ID}::uuid,true,'independent',${USER_ID}::uuid
      )
    `;
    await transaction`
      INSERT INTO publish_jobs(
        id,tenant_id,variant_id,content_version_id,account_id,scheduled_at,
        idempotency_key,payload_hash,status,attempt_count,last_error_json,origin,
        created_by,version
      ) VALUES(
        ${AUTO_JOB_ID}::uuid,${TENANT_ID}::uuid,${VARIANT_ID}::uuid,${VERSION_ID}::uuid,
        ${ACCOUNT_ID}::uuid,${SCHEDULED_AT},'baijiahao:manual-required-124',${CONTENT_HASH},
        'failed',${latestAttemptNo},${transaction.json(error)},'baijiahao_automation',
        ${USER_ID}::uuid,3
      )
    `;
    await transaction`
      INSERT INTO publish_attempts(
        tenant_id,publish_job_id,attempt_no,adapter_code,status,request_hash,
        response_json,error_code,started_at,finished_at
      ) VALUES
        (
          ${TENANT_ID}::uuid,${AUTO_JOB_ID}::uuid,1,'baijiahao-delivery@1.1.0','unknown',
          ${'b'.repeat(64)},${transaction.json({ message: 'Publish state unknown' })},
          'PUBLISH_STATE_UNKNOWN',now() - interval '2 minutes',now() - interval '2 minutes'
        ),
        (
          ${TENANT_ID}::uuid,${AUTO_JOB_ID}::uuid,${latestAttemptNo},
          'baijiahao-delivery@1.1.0','failed',
          ${'b'.repeat(64)},${transaction.json({ message: error.message })},
          'MANUAL_REQUIRED',now(),now()
        )
    `;
    await transaction`
      INSERT INTO baijiahao_browser_sessions(
        id,tenant_id,account_id,status,profile_key,authenticated_at,last_verified_at
      ) VALUES(
        ${BROWSER_SESSION_ID}::uuid,${TENANT_ID}::uuid,${ACCOUNT_ID}::uuid,'authenticated',
        'baijiahao/test/account-124',now(),now()
      )
    `;
    await transaction`
      INSERT INTO baijiahao_browser_publications(
        id,tenant_id,session_id,account_id,publish_job_id,content_version_id,
        idempotency_key,payload_hash,content_fingerprint,title,status,submitted_at
      ) VALUES(
        ${BROWSER_PUBLICATION_ID}::uuid,${TENANT_ID}::uuid,${BROWSER_SESSION_ID}::uuid,
        ${ACCOUNT_ID}::uuid,${AUTO_JOB_ID}::uuid,${VERSION_ID}::uuid,
        'baijiahao:manual-required-124',${CONTENT_HASH},${'b'.repeat(64)},
        '百家号需人工核实测试','manual_required',now()
      )
    `;
    await transaction`
      INSERT INTO baijiahao_automation_runs(
        id,tenant_id,policy_id,source_mode,variant_id,content_version_id,
        status,publish_job_id,last_error_json,finished_at
      ) VALUES(
        ${AUTOMATION_RUN_ID}::uuid,${TENANT_ID}::uuid,${POLICY_ID}::uuid,'independent',
        ${VARIANT_ID}::uuid,${VERSION_ID}::uuid,'manual_required',${AUTO_JOB_ID}::uuid,
        ${transaction.json(error)},now()
      )
    `;
    await transaction`
      INSERT INTO baijiahao_daily_batches(
        id,tenant_id,policy_id,business_date,status
      ) VALUES(
        ${BAIJIAHAO_BATCH_ID}::uuid,${TENANT_ID}::uuid,${POLICY_ID}::uuid,
        (now() AT TIME ZONE 'Asia/Shanghai')::date,'running'
      )
    `;
    await transaction`
      INSERT INTO baijiahao_daily_batch_items(
        id,tenant_id,batch_id,candidate_no,automation_run_id,brief_id,
        package_id,variant_id,content_version_id,publish_job_id,status,last_error_json
      ) VALUES(
        ${BAIJIAHAO_BATCH_ITEM_ID}::uuid,${TENANT_ID}::uuid,${BAIJIAHAO_BATCH_ID}::uuid,1,
        ${AUTOMATION_RUN_ID}::uuid,${BRIEF_ID}::uuid,${PACKAGE_ID}::uuid,
        ${VARIANT_ID}::uuid,${VERSION_ID}::uuid,${AUTO_JOB_ID}::uuid,'manual_required',
        ${transaction.json(error)}
      )
    `;
  });
  return { id: AUTO_JOB_ID };
}

async function seedLiejuOfficialUnknownAutomation(database: Sql) {
  const error = {
    code: 'PUBLISH_STATE_UNKNOWN',
    message: 'Lieju official API returned an unrecognized publication response',
    schema_version: 'adapter-error@1',
  };
  await database.begin(async (transaction) => {
    await transaction`
      UPDATE briefs SET platform_codes=ARRAY['lieju']::varchar[] WHERE id=${BRIEF_ID}::uuid
    `;
    await transaction`
      UPDATE platform_accounts SET
        platform_code='lieju',provider_account_id=NULL,display_name='Lieju Official API',
        capabilities_json=${transaction.json({ delivery_method: 'official_api', publish: true })}
      WHERE id=${ACCOUNT_ID}::uuid
    `;
    await transaction`
      UPDATE content_variants SET platform_code='lieju',platform_account_id=${ACCOUNT_ID}::uuid,
        status='publish_failed',version=3
      WHERE id=${VARIANT_ID}::uuid
    `;
    await transaction`
      UPDATE content_packages SET status='publish_failed',version=2
      WHERE id=${PACKAGE_ID}::uuid
    `;
    await transaction`
      INSERT INTO browser_platform_automation_policies(
        id,tenant_id,workspace_id,project_id,account_id,platform_code,
        enabled,daily_enabled,created_by
      ) VALUES(
        ${POLICY_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,${PROJECT_ID}::uuid,
        ${ACCOUNT_ID}::uuid,'lieju',true,true,${USER_ID}::uuid
      )
    `;
    await transaction`
      INSERT INTO publish_jobs(
        id,tenant_id,variant_id,content_version_id,account_id,scheduled_at,
        idempotency_key,payload_hash,status,attempt_count,last_error_json,origin,
        created_by,version
      ) VALUES(
        ${AUTO_JOB_ID}::uuid,${TENANT_ID}::uuid,${VARIANT_ID}::uuid,${VERSION_ID}::uuid,
        ${ACCOUNT_ID}::uuid,${SCHEDULED_AT},'lieju:unknown-124',${CONTENT_HASH},
        'failed',2,${transaction.json(error)},'lieju_automation',${USER_ID}::uuid,3
      )
    `;
    await transaction`
      INSERT INTO publish_attempts(
        tenant_id,publish_job_id,attempt_no,adapter_code,status,request_hash,
        response_json,error_code,started_at,finished_at
      ) VALUES
        (
          ${TENANT_ID}::uuid,${AUTO_JOB_ID}::uuid,1,'lieju-delivery@1.0.0','failed',
          ${'b'.repeat(64)},${transaction.json({ message: 'Render validation failed' })},
          'PUBLISHER_RENDER_BLOCKED',now() - interval '2 minutes',now() - interval '2 minutes'
        ),
        (
          ${TENANT_ID}::uuid,${AUTO_JOB_ID}::uuid,2,'lieju-delivery@1.0.0','unknown',
          ${'c'.repeat(64)},${transaction.json({ message: error.message })},
          'PUBLISH_STATE_UNKNOWN',now(),now()
        )
    `;
    await transaction`
      INSERT INTO lieju_api_publications(
        id,tenant_id,account_id,publish_job_id,content_version_id,idempotency_key,
        payload_hash,attempt_no,status,response_hash,submitted_at,last_error_json
      ) VALUES(
        ${BROWSER_PUBLICATION_ID}::uuid,${TENANT_ID}::uuid,${ACCOUNT_ID}::uuid,
        ${AUTO_JOB_ID}::uuid,${VERSION_ID}::uuid,'lieju:unknown-124',${CONTENT_HASH},2,
        'manual_required',${'d'.repeat(64)},now(),${transaction.json(error)}
      )
    `;
    await transaction`
      INSERT INTO browser_platform_automation_runs(
        id,tenant_id,policy_id,platform_code,variant_id,content_version_id,
        status,publish_job_id,last_error_json,finished_at
      ) VALUES(
        ${AUTOMATION_RUN_ID}::uuid,${TENANT_ID}::uuid,${POLICY_ID}::uuid,'lieju',
        ${VARIANT_ID}::uuid,${VERSION_ID}::uuid,'manual_required',${AUTO_JOB_ID}::uuid,
        ${transaction.json(error)},now()
      )
    `;
    await transaction`
      INSERT INTO browser_platform_daily_batches(
        id,tenant_id,policy_id,business_date,status,scheduled_at,last_error_json
      ) VALUES(
        ${BAIJIAHAO_BATCH_ID}::uuid,${TENANT_ID}::uuid,${POLICY_ID}::uuid,
        (now() AT TIME ZONE 'Asia/Shanghai')::date,'attention_required',now(),
        ${transaction.json(error)}
      )
    `;
    await transaction`
      INSERT INTO browser_platform_daily_batch_items(
        id,tenant_id,batch_id,candidate_no,automation_run_id,brief_id,package_id,
        variant_id,content_version_id,publish_job_id,status,qualified_at,scheduled_at,
        last_error_json
      ) VALUES(
        ${BAIJIAHAO_BATCH_ITEM_ID}::uuid,${TENANT_ID}::uuid,${BAIJIAHAO_BATCH_ID}::uuid,3,
        ${AUTOMATION_RUN_ID}::uuid,${BRIEF_ID}::uuid,${PACKAGE_ID}::uuid,
        ${VARIANT_ID}::uuid,${VERSION_ID}::uuid,${AUTO_JOB_ID}::uuid,
        'manual_required',now(),now(),${transaction.json(error)}
      )
    `;
  });
  return { id: AUTO_JOB_ID };
}

async function contentState(database: Sql) {
  const rows = await database<
    { packageStatus: string; variantStatus: string; variantVersion: number }[]
  >`
    SELECT package.status AS "packageStatus", variant.status AS "variantStatus",
      variant.version AS "variantVersion"
    FROM content_variants AS variant
    JOIN content_packages AS package ON package.id=variant.package_id
    WHERE variant.id=${VARIANT_ID}::uuid
  `;
  return rows[0];
}

async function auditActions(database: Sql, jobId: string): Promise<readonly string[]> {
  const rows = await database<{ action: string }[]>`
    SELECT action FROM audit_events WHERE resource_id=${jobId}::uuid ORDER BY created_at,id
  `;
  return rows.map(({ action }) => action);
}

async function seedAutomationJob(
  database: Sql,
  status: 'failed' | 'scheduled',
  attemptCount: number,
): Promise<void> {
  const variantStatus = status === 'failed' ? 'publish_failed' : 'scheduled';
  await database`
    UPDATE content_variants SET status=${variantStatus},platform_account_id=${ACCOUNT_ID}::uuid
    WHERE id=${VARIANT_ID}::uuid
  `;
  await database`
    UPDATE content_packages SET status=${variantStatus}
    WHERE id=${PACKAGE_ID}::uuid
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
    INSERT INTO publish_jobs(
      id,tenant_id,variant_id,content_version_id,account_id,scheduled_at,
      idempotency_key,payload_hash,status,attempt_count,last_error_json,origin,created_by
    ) VALUES(
      ${AUTO_JOB_ID}::uuid,${TENANT_ID}::uuid,${VARIANT_ID}::uuid,${VERSION_ID}::uuid,
      ${ACCOUNT_ID}::uuid,${SCHEDULED_AT},'official-site:auto-job-124',${CONTENT_HASH},
      ${status},${attemptCount},
      ${status === 'failed' ? database.json({ code: 'PUBLISH_REJECTED' }) : null},
      'official_site_automation',${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO official_site_automation_runs(
      id,tenant_id,policy_id,variant_id,content_version_id,status,publish_job_id,finished_at
    ) VALUES(
      ${AUTOMATION_RUN_ID}::uuid,${TENANT_ID}::uuid,${POLICY_ID}::uuid,${VARIANT_ID}::uuid,
      ${VERSION_ID}::uuid,${status === 'failed' ? 'publish_failed' : 'publishing'},
      ${AUTO_JOB_ID}::uuid,${status === 'failed' ? new Date() : null}
    )
  `;
  if (status === 'failed') {
    await database`
      INSERT INTO publish_attempts(
        tenant_id,publish_job_id,attempt_no,adapter_code,status,request_hash,
        error_code,started_at,finished_at
      ) VALUES(
        ${TENANT_ID}::uuid,${AUTO_JOB_ID}::uuid,${attemptCount},'official-site@1','failed',
        ${'c'.repeat(64)},'PUBLISH_REJECTED',now(),now()
      )
    `;
  }
}

async function automationState(database: Sql) {
  const rows = await database<
    { automationStatus: string; jobStatus: string; variantStatus: string }[]
  >`
    SELECT automation.status AS "automationStatus",job.status AS "jobStatus",
      variant.status AS "variantStatus"
    FROM official_site_automation_runs AS automation
    JOIN publish_jobs AS job ON job.id=automation.publish_job_id
    JOIN content_variants AS variant ON variant.id=automation.variant_id
    WHERE automation.id=${AUTOMATION_RUN_ID}::uuid
  `;
  return rows[0];
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users(id,email,display_name,status) VALUES
      (${USER_ID}::uuid,'publisher-124@example.com','Publisher','active'),
      (${OTHER_USER_ID}::uuid,'other-publisher-124@example.com','Other Publisher','active')
  `;
  await database`
    INSERT INTO tenants(id,name,slug,status)
    VALUES(${TENANT_ID}::uuid,'Publish Job Tenant','publish-job-tenant-124','active')
  `;
  await database`
    INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES
      (${TENANT_ID}::uuid,${USER_ID}::uuid,'publisher','active'),
      (${TENANT_ID}::uuid,${OTHER_USER_ID}::uuid,'publisher','active')
  `;
  await database`
    INSERT INTO workspaces(id,tenant_id,name,slug,timezone,status) VALUES
      (${WORKSPACE_ID}::uuid,${TENANT_ID}::uuid,'Publishing','publishing-124','Asia/Shanghai','active'),
      (${OTHER_WORKSPACE_ID}::uuid,${TENANT_ID}::uuid,'Other','other-publishing-124','Asia/Shanghai','active')
  `;
  await database`
    INSERT INTO workspace_memberships(workspace_id,user_id,scope_json) VALUES
      (${WORKSPACE_ID}::uuid,${USER_ID}::uuid,'{}'::jsonb),
      (${OTHER_WORKSPACE_ID}::uuid,${OTHER_USER_ID}::uuid,'{}'::jsonb)
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
      ${BRIEF_ID}::uuid,'approved',${USER_ID}::uuid
    )
  `;
  await database`
    INSERT INTO content_variants(id,tenant_id,package_id,platform_code,status)
    VALUES(${VARIANT_ID}::uuid,${TENANT_ID}::uuid,${PACKAGE_ID}::uuid,'official_site','approved')
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
      capabilities_json,publish_mode,status,timezone
    ) VALUES(
      ${ACCOUNT_ID}::uuid,${TENANT_ID}::uuid,${WORKSPACE_ID}::uuid,'official_site',
      'provider-account-124','Official Site',${database.json({ export: true, publish: true })},
      'api','active','Asia/Shanghai'
    )
  `;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('PostgreSQL client is not initialized');
  return client;
}
