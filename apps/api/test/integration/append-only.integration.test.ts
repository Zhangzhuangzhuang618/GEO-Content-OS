import type { StructuredLogger } from '@geo-content-os/observability';
import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import { RequiredAuditWriteError, RequiredAuditWriter } from '../../src/modules/audit/index.js';

const USER = '1d000000-0000-4000-8000-000000000133';
const UNKNOWN_USER = '1d000000-0000-4000-8000-000000000233';
const TENANT = '2d000000-0000-4000-8000-000000000133';
const WORKSPACE = '3d000000-0000-4000-8000-000000000133';
const PROJECT = '4d000000-0000-4000-8000-000000000133';
const BRIEF = '5d000000-0000-4000-8000-000000000133';
const PACKAGE = '6d000000-0000-4000-8000-000000000133';
const VARIANT = '7d000000-0000-4000-8000-000000000133';
const VERSION = '8d000000-0000-4000-8000-000000000133';
const ACCOUNT = '9d000000-0000-4000-8000-000000000133';
const JOB = 'ad000000-0000-4000-8000-000000000133';
const ATTEMPT = 'bd000000-0000-4000-8000-000000000133';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

describe('append-only audit controls', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  let logger: TestLogger;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 4 });
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`
      TRUNCATE export_artifacts, publish_attempts, publish_jobs, media_assets,
        platform_accounts, usage_ledger, ai_citations, content_block_locks,
        content_blocks, content_versions, content_variants, content_packages,
        fact_sources, facts, embeddings, source_chunks, ingest_jobs, brief_sources,
        brief_keywords, briefs, source_documents, topic_candidates, generation_runs,
        keywords, keyword_sets, brand_profiles, workspace_memberships, projects,
        workspaces, audit_events, outbox_events, support_access_grants,
        idempotency_records, password_reset_tokens, invitations, sessions,
        platform_roles, memberships, tenants, users CASCADE
    `;
    await seed(database);
    logger = new TestLogger();
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('writes required audit events in the caller transaction and redacts sensitive values', async () => {
    const database = requireClient(client);
    const writer = new RequiredAuditWriter(logger);
    const record = await database.begin((transaction) =>
      writer.record(transaction, {
        action: 'workspace.settings.update',
        actorId: USER,
        after: { api_key: 'secret-api-key', nested: { password: 'secret-password' }, value: 2 },
        before: { value: 1 },
        ip: '127.0.0.1',
        requestId: 'request-t133-success',
        resourceId: WORKSPACE,
        resourceType: 'workspace',
        tenantId: TENANT,
      }),
    );

    expect(record).toMatchObject({
      action: 'workspace.settings.update',
      actorId: USER,
      after: { api_key: '[REDACTED]', nested: { password: '[REDACTED]' }, value: 2 },
      before: { value: 1 },
      resourceId: WORKSPACE,
      tenantId: TENANT,
    });
    expect(JSON.stringify(record)).not.toContain('secret-');
    expect(logger.errors).toEqual([]);
  });

  it('alerts and aborts the business transaction when a required audit insert fails', async () => {
    const database = requireClient(client);
    const writer = new RequiredAuditWriter(logger);
    await expect(
      database.begin(async (transaction) => {
        await transaction`UPDATE workspaces SET name = 'Must Roll Back' WHERE id = ${WORKSPACE}`;
        await writer.record(transaction, {
          action: 'workspace.settings.update',
          actorId: UNKNOWN_USER,
          after: { name: 'Must Roll Back' },
          requestId: 'request-t133-failure',
          resourceId: WORKSPACE,
          resourceType: 'workspace',
          tenantId: TENANT,
        });
      }),
    ).rejects.toBeInstanceOf(RequiredAuditWriteError);

    const rows = await database<{ name: string }[]>`
      SELECT name FROM workspaces WHERE id = ${WORKSPACE}
    `;
    expect(rows).toEqual([{ name: 'Audit Workspace' }]);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]).toMatchObject({
      attributes: {
        action: 'workspace.settings.update',
        audit_required: true,
        request_id: 'request-t133-failure',
        resource_type: 'workspace',
        tenant_id: TENANT,
      },
      message: 'Required audit write failed; aborting business transaction',
    });
  });

  it('rejects updates and deletes for audit events, usage ledger, and publish attempts', async () => {
    const database = requireClient(client);
    const audit = await database.begin((transaction) =>
      new RequiredAuditWriter(logger).record(transaction, {
        action: 'append-only.verify',
        actorId: USER,
        requestId: 'request-t133-append-only',
        resourceType: 'system_check',
        tenantId: TENANT,
      }),
    );
    const ledger = await database<{ id: string }[]>`
      INSERT INTO usage_ledger (
        tenant_id, request_id, cost_category, provider, quantity, unit,
        cost_cents, currency, status
      ) VALUES (
        ${TENANT}, 'append-only-usage', 'queue', 'redis', 1, 'request', 2, 'CNY', 'estimated'
      ) RETURNING id
    `;
    const ledgerId = ledger[0]?.id;
    if (!ledgerId) throw new Error('Usage ledger seed failed');

    await expect(
      database`UPDATE audit_events SET action = 'changed' WHERE id = ${audit.id}`,
    ).rejects.toThrow(/append-only/u);
    await expect(database`DELETE FROM audit_events WHERE id = ${audit.id}`).rejects.toThrow(
      /append-only/u,
    );
    await expect(
      database`UPDATE usage_ledger SET cost_cents = 3 WHERE id = ${ledgerId}`,
    ).rejects.toThrow(/append-only/u);
    await expect(database`DELETE FROM usage_ledger WHERE id = ${ledgerId}`).rejects.toThrow(
      /append-only/u,
    );
    await expect(
      database`UPDATE publish_attempts SET status = 'failed' WHERE id = ${ATTEMPT}`,
    ).rejects.toThrow(/append-only/u);
    await expect(database`DELETE FROM publish_attempts WHERE id = ${ATTEMPT}`).rejects.toThrow(
      /append-only/u,
    );
  });
});

interface LoggedError {
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly error?: unknown;
  readonly message: string;
}

class TestLogger implements StructuredLogger {
  public readonly errors: LoggedError[] = [];

  public child(): StructuredLogger {
    return this;
  }

  public debug(): void {}

  public info(): void {}

  public warn(): void {}

  public error(
    message: string,
    error?: unknown,
    attributes?: Readonly<Record<string, unknown>>,
  ): void {
    this.errors.push({
      ...(attributes === undefined ? {} : { attributes }),
      ...(error === undefined ? {} : { error }),
      message,
    });
  }
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id,email,display_name,status)
    VALUES (${USER},'audit-owner@example.com','Audit Owner','active')
  `;
  await database`
    INSERT INTO tenants (id,name,slug,status)
    VALUES (${TENANT},'Audit Tenant','audit-tenant','active')
  `;
  await database`
    INSERT INTO memberships (tenant_id,user_id,role_code,status)
    VALUES (${TENANT},${USER},'tenant_owner','active')
  `;
  await database`
    INSERT INTO workspaces (id,tenant_id,name,slug,timezone,status)
    VALUES (${WORKSPACE},${TENANT},'Audit Workspace','audit-workspace','UTC','active')
  `;
  await database`
    INSERT INTO projects (id,tenant_id,workspace_id,name,owner_id,status)
    VALUES (${PROJECT},${TENANT},${WORKSPACE},'Audit Project',${USER},'active')
  `;
  await database`
    INSERT INTO briefs (
      id,tenant_id,workspace_id,project_id,title,objective,audience,
      platform_codes,constraints_json,created_by
    ) VALUES (
      ${BRIEF},${TENANT},${WORKSPACE},${PROJECT},'Audit Brief','trust',
      'Enterprise append only audit team',ARRAY['official_site'],
      ${database.json({ schema_version: 'brief-constraints@1' })},${USER}
    )
  `;
  await database`
    INSERT INTO content_packages (
      id,tenant_id,workspace_id,project_id,brief_id,status,created_by
    ) VALUES (${PACKAGE},${TENANT},${WORKSPACE},${PROJECT},${BRIEF},'approved',${USER})
  `;
  await database`
    INSERT INTO content_variants (id,tenant_id,package_id,platform_code,status)
    VALUES (${VARIANT},${TENANT},${PACKAGE},'official_site','approved')
  `;
  await database`
    INSERT INTO content_versions (
      id,tenant_id,package_id,variant_id,version_no,schema_version,
      content_json,content_hash,created_by
    ) VALUES (
      ${VERSION},${TENANT},${PACKAGE},${VARIANT},1,'content-document@1',
      ${database.json({ schema_version: 'content-document@1', title: 'Audit content' })},
      ${HASH_A},${USER}
    )
  `;
  await database`
    UPDATE content_variants SET current_content_version_id = ${VERSION} WHERE id = ${VARIANT}
  `;
  await database`
    INSERT INTO platform_accounts (
      id,tenant_id,workspace_id,platform_code,provider_account_id,display_name,
      credential_ciphertext,credential_key_version,scopes,capabilities_json,
      publish_mode,status,timezone
    ) VALUES (
      ${ACCOUNT},${TENANT},${WORKSPACE},'official_site','audit-site','Audit Site',
      'encrypted','local-v1',ARRAY['publish'],
      ${database.json({ publish: true, schema_version: 'adapter-capability@1' })},
      'api','active','UTC'
    )
  `;
  await database`
    INSERT INTO publish_jobs (
      id,tenant_id,variant_id,content_version_id,account_id,scheduled_at,
      idempotency_key,payload_hash,status,attempt_count,created_by
    ) VALUES (
      ${JOB},${TENANT},${VARIANT},${VERSION},${ACCOUNT},now() + INTERVAL '1 hour',
      'append-only-job',${HASH_B},'scheduled',1,${USER}
    )
  `;
  await database`
    INSERT INTO publish_attempts (
      id,tenant_id,publish_job_id,attempt_no,adapter_code,status,
      request_hash,response_json,started_at,finished_at
    ) VALUES (
      ${ATTEMPT},${TENANT},${JOB},1,'official-site-adapter','succeeded',
      ${HASH_C},${database.json({ external_post_id: 'audit-post' })},
      now() - INTERVAL '1 minute',now()
    )
  `;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Append-only PostgreSQL client is not initialized');
  return client;
}
