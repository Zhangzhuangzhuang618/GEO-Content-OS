import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import {
  PublishJobService,
  type PublishJobScope,
} from '../../src/modules/publishing/jobs/index.js';

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
    client = postgres(container.getConnectionUri(), { max: 4 });
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

  it('cancels a queued website automation and returns the article to quality-passed', async () => {
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
        ${TENANT_ID}::uuid,${jobId}::uuid,1,'official-site@1',${attemptStatus},
        ${'b'.repeat(64)},
        ${attemptStatus === 'unknown' ? 'PUBLISH_STATE_UNKNOWN' : 'PUBLISH_REJECTED'},now(),now()
      )
    `;
  });
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
