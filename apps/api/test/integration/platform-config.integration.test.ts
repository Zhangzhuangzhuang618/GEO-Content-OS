import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createHash, randomBytes } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApplication } from '../../src/application.js';
import { migrateDatabase } from '../../src/database/migrate.js';

const OPERATOR = '10000000-0000-4000-8000-000000000100';
const ADMIN = '11000000-0000-4000-8000-000000000100';
const TENANT_USER = '12000000-0000-4000-8000-000000000100';
const TENANT = '20000000-0000-4000-8000-000000000100';

describe('platform configuration API', () => {
  let application: NestFastifyApplication | undefined;
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  let originalDatabaseUrl: string | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 6 });
    originalDatabaseUrl = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = container.getConnectionUri();
    application = await createApplication({
      enableShutdownHooks: false,
      logger: false,
      securityConfiguration: {
        allowedOrigins: ['https://app.example.com'],
        environment: 'test',
        production: false,
        rateLimit: { max: 1_000, timeWindowMs: 60_000 },
        trustProxy: false,
      },
    });
    await application.init();
    await application.getHttpAdapter().getInstance().ready();
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`
      TRUNCATE prompt_versions, platform_rule_versions, audit_events,
        idempotency_records, sessions, platform_roles, memberships, tenants, users CASCADE
    `;
    await database`
      INSERT INTO users (id,email,display_name,status) VALUES
        (${OPERATOR},'operator@example.com','Platform Operator','active'),
        (${ADMIN},'admin@example.com','Platform Admin','active'),
        (${TENANT_USER},'tenant@example.com','Tenant User','active')
    `;
    await database`
      INSERT INTO platform_roles (user_id,role_code,status) VALUES
        (${OPERATOR},'platform_operator','active'),
        (${ADMIN},'platform_admin','active')
    `;
    await database`
      INSERT INTO tenants (id,name,slug,status)
      VALUES (${TENANT},'Config Tenant','config-tenant','active')
    `;
    await database`
      INSERT INTO memberships (tenant_id,user_id,role_code,status)
      VALUES (${TENANT},${TENANT_USER},'tenant_owner','active')
    `;
  });

  afterAll(async () => {
    await application?.close();
    await client?.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = originalDatabaseUrl;
  });

  it('creates, replays, publishes and retires an immutable prompt version with global audit', async () => {
    const database = requireClient(client);
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const operator = await createSession(database, OPERATOR);
    const payload = {
      change_summary: 'Add citation preservation',
      schema_version: 'content-writer-data@1',
      semantic_version: '1.2.0',
      skill_name: 'content-writer',
      system_prompt: 'Use only supplied evidence.',
      task_template: 'Write {{brief}} and preserve {{citations}}.',
    };
    const first = await server.inject({
      headers: { ...writeHeaders(operator), 'idempotency-key': 'prompt-create-100' },
      method: 'POST',
      payload,
      url: '/api/v1/platform/prompt-versions',
    });
    const replay = await server.inject({
      headers: { ...writeHeaders(operator), 'idempotency-key': 'prompt-create-100' },
      method: 'POST',
      payload,
      url: '/api/v1/platform/prompt-versions',
    });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().data.id).toBe(first.json().data.id);
    expect(first.json().data).toMatchObject({
      change_summary: payload.change_summary,
      semantic_version: '1.2.0',
      status: 'draft',
      version: 1,
    });
    const id = first.json().data.id as string;
    expect(
      await database<{ tenantId: string | null }[]>`
        SELECT tenant_id AS "tenantId" FROM idempotency_records
        WHERE idempotency_key = 'prompt-create-100'
      `,
    ).toEqual([{ tenantId: null }]);

    const published = await server.inject({
      headers: { ...writeHeaders(operator), 'if-match': '"1"' },
      method: 'POST',
      payload: { version: 1 },
      url: `/api/v1/platform/prompt-versions/${id}/publish`,
    });
    expect(published.statusCode).toBe(200);
    expect(published.headers['etag']).toBe('"2"');
    expect(published.json().data).toMatchObject({
      published_by: OPERATOR,
      published_by_name: 'Platform Operator',
      status: 'published',
      version: 2,
    });
    await expect(
      database`UPDATE prompt_versions SET system_prompt = 'overwrite' WHERE id = ${id}`,
    ).rejects.toThrow(/immutable/u);
    const overwrite = await server.inject({
      headers: { ...writeHeaders(operator), 'if-match': '"2"' },
      method: 'POST',
      payload: { version: 2 },
      url: `/api/v1/platform/prompt-versions/${id}/publish`,
    });
    expect(overwrite.statusCode).toBe(409);
    expect(overwrite.json().error.code).toBe('STATE_TRANSITION_INVALID');

    const retired = await server.inject({
      headers: { ...writeHeaders(operator), 'if-match': '"2"' },
      method: 'POST',
      payload: { reason: 'Rollback to a prior pinned version' },
      url: `/api/v1/platform/prompt-versions/${id}/retire`,
    });
    expect(retired.statusCode).toBe(200);
    expect(retired.json().data).toMatchObject({ status: 'retired', version: 3 });
    expect(
      await database<{ action: string; tenantId: string | null }[]>`
        SELECT action, tenant_id AS "tenantId" FROM audit_events ORDER BY created_at
      `,
    ).toEqual([
      { action: 'platform.prompt-version.created', tenantId: null },
      { action: 'platform.prompt-version.published', tenantId: null },
      { action: 'platform.prompt-version.retired', tenantId: null },
    ]);
  });

  it('creates and lists rule versions while denying platform admins and tenant owners', async () => {
    const database = requireClient(client);
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const operator = await createSession(database, OPERATOR);
    const created = await server.inject({
      headers: { ...writeHeaders(operator), 'idempotency-key': 'rule-create-100' },
      method: 'POST',
      payload: {
        change_summary: 'Set answer format',
        platform_code: 'zhihu',
        rules: {
          answer_first: true,
          schema_version: 'platform-rules@1',
          title_max: 60,
        },
        semantic_version: '2.0.0',
      },
      url: '/api/v1/platform/rule-versions',
    });
    expect(created.statusCode).toBe(201);
    const listed = await server.inject({
      headers: readHeaders(operator),
      method: 'GET',
      url: '/api/v1/platform/rule-versions?platform_code=zhihu&status=draft',
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data.items).toEqual([
      expect.objectContaining({
        platform_code: 'zhihu',
        semantic_version: '2.0.0',
        status: 'draft',
      }),
    ]);

    const admin = await createSession(database, ADMIN);
    const tenantOwner = await createSession(database, TENANT_USER, TENANT);
    for (const session of [admin, tenantOwner]) {
      const forbidden = await server.inject({
        headers: readHeaders(session),
        method: 'GET',
        url: '/api/v1/platform/prompt-versions',
      });
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json().error.code).toBe('PERMISSION_DENIED');
    }
  });

  it('rejects stale versions and idempotency-key reuse with different bodies', async () => {
    const database = requireClient(client);
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const operator = await createSession(database, OPERATOR);
    const firstPayload = promptPayload('3.0.0', 'First prompt');
    const first = await server.inject({
      headers: { ...writeHeaders(operator), 'idempotency-key': 'prompt-conflict-100' },
      method: 'POST',
      payload: firstPayload,
      url: '/api/v1/platform/prompt-versions',
    });
    expect(first.statusCode).toBe(201);
    const conflict = await server.inject({
      headers: { ...writeHeaders(operator), 'idempotency-key': 'prompt-conflict-100' },
      method: 'POST',
      payload: promptPayload('3.0.1', 'Different prompt'),
      url: '/api/v1/platform/prompt-versions',
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    const id = first.json().data.id as string;
    const stale = await server.inject({
      headers: { ...writeHeaders(operator), 'if-match': '"2"' },
      method: 'POST',
      payload: { version: 2 },
      url: `/api/v1/platform/prompt-versions/${id}/publish`,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');

    const duplicateVersion = await server.inject({
      headers: { ...writeHeaders(operator), 'idempotency-key': 'prompt-duplicate-version-100' },
      method: 'POST',
      payload: promptPayload('3.0.0', 'Duplicate semantic version'),
      url: '/api/v1/platform/prompt-versions',
    });
    expect(duplicateVersion.statusCode).toBe(409);
    expect(duplicateVersion.json().error.code).toBe('VERSION_CONFLICT');
  });
});

function promptPayload(version: string, systemPrompt: string) {
  return {
    change_summary: `Create ${version}`,
    schema_version: 'quality-checker-data@1',
    semantic_version: version,
    skill_name: 'quality-checker',
    system_prompt: systemPrompt,
    task_template: 'Check {{content}}.',
  };
}

async function createSession(database: Sql, userId: string, tenantId?: string) {
  const session = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  await database`
    INSERT INTO sessions (user_id,active_tenant_id,session_hash,csrf_hash,expires_at)
    VALUES (
      ${userId}, ${tenantId ?? null}, ${sha256(session)}, ${sha256(csrf)},
      now()+interval '1 hour'
    )
  `;
  return { csrf, session };
}

function readHeaders(tokens: { readonly session: string }) {
  return { cookie: `geo_session=${tokens.session}` };
}

function writeHeaders(tokens: { readonly csrf: string; readonly session: string }) {
  return {
    cookie: `geo_session=${tokens.session}; geo_csrf=${tokens.csrf}`,
    'x-csrf-token': tokens.csrf,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireApplication(value: NestFastifyApplication | undefined) {
  if (!value) throw new Error('Platform config test application was not initialized');
  return value;
}

function requireClient(value: Sql | undefined) {
  if (!value) throw new Error('Platform config test PostgreSQL client was not initialized');
  return value;
}
