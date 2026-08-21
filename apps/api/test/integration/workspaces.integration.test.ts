import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApplication } from '../../src/application.js';
import { migrateDatabase } from '../../src/database/migrate.js';

const OWNER_ID = '10000000-0000-4000-8000-000000000022';
const VIEWER_ID = '10000000-0000-4000-8000-000000000122';
const OTHER_OWNER_ID = '10000000-0000-4000-8000-000000000222';
const TENANT_ID = '20000000-0000-4000-8000-000000000022';
const OTHER_TENANT_ID = '20000000-0000-4000-8000-000000000122';
const WORKSPACE_A = '30000000-0000-4000-8000-000000000022';
const WORKSPACE_B = '30000000-0000-4000-8000-000000000122';
const OTHER_WORKSPACE = '30000000-0000-4000-8000-000000000222';
const API_PATH = '/api/v1/workspaces';

describe('workspaces API', () => {
  let application: NestFastifyApplication | undefined;
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  let originalDatabaseUrl: string | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 4 });
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
    await database`TRUNCATE topic_candidates, generation_runs, keywords, keyword_sets, brand_profiles, workspace_memberships, projects, workspaces, audit_events, support_access_grants, idempotency_records, password_reset_tokens, invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
    await database`
      INSERT INTO users (id, email, display_name, status)
      VALUES
        (${OWNER_ID}, 'workspace-owner@example.com', 'Workspace Owner', 'active'),
        (${VIEWER_ID}, 'workspace-viewer@example.com', 'Workspace Viewer', 'active'),
        (${OTHER_OWNER_ID}, 'other-workspace-owner@example.com', 'Other Owner', 'active')
    `;
    await database`
      INSERT INTO tenants (id, name, slug, status)
      VALUES
        (${TENANT_ID}, 'Workspace Tenant', 'workspace-api-tenant', 'active'),
        (${OTHER_TENANT_ID}, 'Other Workspace Tenant', 'other-workspace-api-tenant', 'active')
    `;
    await database`
      INSERT INTO memberships (tenant_id, user_id, role_code, status)
      VALUES
        (${TENANT_ID}, ${OWNER_ID}, 'tenant_owner', 'active'),
        (${TENANT_ID}, ${VIEWER_ID}, 'viewer', 'active'),
        (${OTHER_TENANT_ID}, ${OTHER_OWNER_ID}, 'tenant_owner', 'active')
    `;
    await database`
      INSERT INTO workspaces (id, tenant_id, name, slug, timezone, settings_json)
      VALUES
        (${WORKSPACE_A}, ${TENANT_ID}, 'Alpha Workspace', 'alpha', 'Asia/Shanghai', '{"schema_version":"workspace-settings@1"}'::jsonb),
        (${WORKSPACE_B}, ${TENANT_ID}, 'Beta Workspace', 'beta', 'UTC', '{"schema_version":"workspace-settings@1"}'::jsonb),
        (${OTHER_WORKSPACE}, ${OTHER_TENANT_ID}, 'Hidden Workspace', 'hidden', 'UTC', '{"schema_version":"workspace-settings@1"}'::jsonb)
    `;
  });

  afterAll(async () => {
    await application?.close();
    await client?.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = originalDatabaseUrl;
  });

  it('creates idempotently, validates input, audits atomically, and enforces manage permission', async () => {
    const database = requireClient(client);
    const server = requireServer(application);
    const owner = await createSession(database, OWNER_ID, TENANT_ID);
    const payload = {
      name: 'Editorial Workspace',
      settings: {
        budget_policy: { hard_limit: true, monthly_limit_cny: 20_000 },
        default_platform_codes: ['official_site', 'zhihu'],
        schema_version: 'workspace-settings@1',
      },
      slug: 'editorial',
      timezone: 'Asia/Shanghai',
    };
    const first = await server.inject({
      headers: { ...writeHeaders(owner), 'idempotency-key': 'workspace-create-001' },
      method: 'POST',
      payload,
      url: API_PATH,
    });
    const replay = await server.inject({
      headers: { ...writeHeaders(owner), 'idempotency-key': 'workspace-create-001' },
      method: 'POST',
      payload,
      url: API_PATH,
    });
    expect(first.statusCode).toBe(201);
    expect(first.headers.etag).toBe('"1"');
    expect(replay.statusCode).toBe(201);
    expect(replay.json().data.id).toBe(first.json().data.id);
    expect(
      await database`SELECT id FROM workspaces WHERE tenant_id = ${TENANT_ID} AND slug = 'editorial'`,
    ).toHaveLength(1);
    expect(
      await database`SELECT id FROM audit_events WHERE action = 'workspace.created'`,
    ).toHaveLength(1);

    const duplicateSlug = await server.inject({
      headers: { ...writeHeaders(owner), 'idempotency-key': 'workspace-create-002' },
      method: 'POST',
      payload: { ...payload, name: 'Duplicate' },
      url: API_PATH,
    });
    expect(duplicateSlug.statusCode).toBe(409);
    expect(duplicateSlug.json().error.code).toBe('STATE_TRANSITION_INVALID');

    const invalidTimezone = await server.inject({
      headers: { ...writeHeaders(owner), 'idempotency-key': 'workspace-create-003' },
      method: 'POST',
      payload: { ...payload, slug: 'invalid-timezone', timezone: 'Mars/Olympus' },
      url: API_PATH,
    });
    expect(invalidTimezone.statusCode).toBe(422);
    expect(invalidTimezone.json().error.code).toBe('SCHEMA_VALIDATION_FAILED');

    const viewer = await createSession(database, VIEWER_ID, TENANT_ID);
    const forbidden = await server.inject({
      headers: { ...writeHeaders(viewer), 'idempotency-key': 'workspace-create-004' },
      method: 'POST',
      payload: { ...payload, slug: 'forbidden' },
      url: API_PATH,
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('PERMISSION_DENIED');
  });

  it('lists with stable cursors and applies explicit workspace scope without leaking tenants', async () => {
    const database = requireClient(client);
    const server = requireServer(application);
    const viewer = await createSession(database, VIEWER_ID, TENANT_ID);
    const all = await server.inject({
      headers: readHeaders(viewer),
      method: 'GET',
      url: `${API_PATH}?limit=1`,
    });
    expect(all.statusCode).toBe(200);
    expect(all.json().data).toHaveLength(1);
    expect(all.json().meta.next_cursor).toEqual(expect.any(String));
    const second = await server.inject({
      headers: readHeaders(viewer),
      method: 'GET',
      url: `${API_PATH}?limit=1&cursor=${encodeURIComponent(all.json().meta.next_cursor)}`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().data).toHaveLength(1);
    expect(second.json().data[0].id).not.toBe(all.json().data[0].id);

    await database`
      INSERT INTO workspace_memberships (workspace_id, user_id, scope_json)
      VALUES (${WORKSPACE_A}, ${VIEWER_ID}, '{"schema_version":"workspace-scope@1"}'::jsonb)
    `;
    const scoped = await server.inject({
      headers: readHeaders(viewer),
      method: 'GET',
      url: API_PATH,
    });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json().data.map((item: { id: string }) => item.id)).toEqual([WORKSPACE_A]);

    const hidden = await server.inject({
      headers: readHeaders(viewer),
      method: 'GET',
      url: `${API_PATH}/${OTHER_WORKSPACE}`,
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe('RESOURCE_NOT_FOUND');

    const invalidCursor = await server.inject({
      headers: readHeaders(viewer),
      method: 'GET',
      url: `${API_PATH}?cursor=not-a-workspace-cursor`,
    });
    expect(invalidCursor.statusCode).toBe(422);
  });

  it('updates with key plus version and rejects stale or missing preconditions', async () => {
    const database = requireClient(client);
    const server = requireServer(application);
    const owner = await createSession(database, OWNER_ID, TENANT_ID);
    const headers = {
      ...writeHeaders(owner),
      'idempotency-key': 'workspace-update-001',
      'if-match': '"1"',
    };
    const first = await server.inject({
      headers,
      method: 'PATCH',
      payload: {
        name: 'Alpha Updated',
        settings: {
          official_site_service_phone: '02085627757',
          schema_version: 'workspace-settings@1',
        },
        timezone: 'America/New_York',
      },
      url: `${API_PATH}/${WORKSPACE_A}`,
    });
    const replay = await server.inject({
      headers,
      method: 'PATCH',
      payload: {
        name: 'Alpha Updated',
        settings: {
          official_site_service_phone: '02085627757',
          schema_version: 'workspace-settings@1',
        },
        timezone: 'America/New_York',
      },
      url: `${API_PATH}/${WORKSPACE_A}`,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({
      name: 'Alpha Updated',
      settings: { official_site_service_phone: '02085627757' },
      version: 2,
    });
    expect(first.headers.etag).toBe('"2"');
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.version).toBe(2);
    expect(
      await database`SELECT id FROM audit_events WHERE action = 'workspace.updated'`,
    ).toHaveLength(1);

    const stale = await server.inject({
      headers: {
        ...writeHeaders(owner),
        'idempotency-key': 'workspace-update-002',
        'if-match': '1',
      },
      method: 'PATCH',
      payload: { name: 'Stale Update' },
      url: `${API_PATH}/${WORKSPACE_A}`,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');

    const missingVersion = await server.inject({
      headers: { ...writeHeaders(owner), 'idempotency-key': 'workspace-update-003' },
      method: 'PATCH',
      payload: { name: 'No Version' },
      url: `${API_PATH}/${WORKSPACE_A}`,
    });
    expect(missingVersion.statusCode).toBe(422);
  });

  it('archives idempotently, records the reason, and retains one active workspace', async () => {
    const database = requireClient(client);
    const server = requireServer(application);
    const owner = await createSession(database, OWNER_ID, TENANT_ID);
    const request = {
      headers: { ...writeHeaders(owner), 'if-match': '1' },
      method: 'POST' as const,
      payload: { reason: 'Consolidating editorial operations' },
      url: `${API_PATH}/${WORKSPACE_A}/archive`,
    };
    const archived = await server.inject(request);
    const replay = await server.inject(request);
    expect(archived.statusCode).toBe(200);
    expect(archived.json().data).toMatchObject({ status: 'archived', version: 2 });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.version).toBe(2);
    const audits = await database<{ after: { reason: string } }[]>`
      SELECT after_json AS after FROM audit_events WHERE action = 'workspace.archived'
    `;
    expect(audits).toHaveLength(1);
    expect(audits[0]?.after.reason).toBe('Consolidating editorial operations');

    const lastActive = await server.inject({
      headers: { ...writeHeaders(owner), 'if-match': '1' },
      method: 'POST',
      payload: { reason: 'Attempt to remove the final active workspace' },
      url: `${API_PATH}/${WORKSPACE_B}/archive`,
    });
    expect(lastActive.statusCode).toBe(409);
    expect(lastActive.json().error.code).toBe('STATE_TRANSITION_INVALID');
  });
});

async function createSession(
  database: Sql,
  userId: string,
  tenantId: string,
): Promise<{ readonly csrf: string; readonly session: string }> {
  const session = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  await database`
    INSERT INTO sessions (user_id, active_tenant_id, session_hash, csrf_hash, expires_at)
    VALUES (${userId}, ${tenantId}, ${sha256(session)}, ${sha256(csrf)}, now() + interval '1 hour')
  `;
  return { csrf, session };
}

function writeHeaders(tokens: { readonly csrf: string; readonly session: string }) {
  return {
    cookie: `geo_session=${tokens.session}; geo_csrf=${tokens.csrf}`,
    'x-csrf-token': tokens.csrf,
  };
}

function readHeaders(tokens: { readonly session: string }) {
  return { cookie: `geo_session=${tokens.session}` };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireServer(application: NestFastifyApplication | undefined): FastifyInstance {
  if (!application) throw new Error('Workspace test application was not initialized');
  return application.getHttpAdapter().getInstance();
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Workspace test PostgreSQL client was not initialized');
  return client;
}
