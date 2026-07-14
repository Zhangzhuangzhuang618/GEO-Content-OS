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

const OWNER_ID = '10000000-0000-4000-8000-000000000023';
const STRATEGY_ID = '10000000-0000-4000-8000-000000000123';
const CONTENT_ID = '10000000-0000-4000-8000-000000000223';
const VIEWER_ID = '10000000-0000-4000-8000-000000000323';
const OTHER_OWNER_ID = '10000000-0000-4000-8000-000000000423';
const TENANT_ID = '20000000-0000-4000-8000-000000000023';
const OTHER_TENANT_ID = '20000000-0000-4000-8000-000000000123';
const WORKSPACE_A = '30000000-0000-4000-8000-000000000023';
const WORKSPACE_B = '30000000-0000-4000-8000-000000000123';
const OTHER_WORKSPACE = '30000000-0000-4000-8000-000000000223';
const PROJECT_A = '40000000-0000-4000-8000-000000000023';
const PROJECT_B = '40000000-0000-4000-8000-000000000123';
const PROJECT_C = '40000000-0000-4000-8000-000000000223';
const OTHER_PROJECT = '40000000-0000-4000-8000-000000000323';
const API_PATH = '/api/v1/projects';

describe('projects API', () => {
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
        (${OWNER_ID}, 'project-owner@example.com', 'Project Owner', 'active'),
        (${STRATEGY_ID}, 'strategy-editor@example.com', 'Strategy Editor', 'active'),
        (${CONTENT_ID}, 'content-editor@example.com', 'Content Editor', 'active'),
        (${VIEWER_ID}, 'project-viewer@example.com', 'Project Viewer', 'active'),
        (${OTHER_OWNER_ID}, 'other-project-owner@example.com', 'Other Owner', 'active')
    `;
    await database`
      INSERT INTO tenants (id, name, slug, status)
      VALUES
        (${TENANT_ID}, 'Project Tenant', 'project-api-tenant', 'active'),
        (${OTHER_TENANT_ID}, 'Other Project Tenant', 'other-project-api-tenant', 'active')
    `;
    await database`
      INSERT INTO memberships (tenant_id, user_id, role_code, status)
      VALUES
        (${TENANT_ID}, ${OWNER_ID}, 'tenant_owner', 'active'),
        (${TENANT_ID}, ${STRATEGY_ID}, 'strategy_editor', 'active'),
        (${TENANT_ID}, ${CONTENT_ID}, 'content_editor', 'active'),
        (${TENANT_ID}, ${VIEWER_ID}, 'viewer', 'active'),
        (${OTHER_TENANT_ID}, ${OTHER_OWNER_ID}, 'tenant_owner', 'active')
    `;
    await database`
      INSERT INTO workspaces (id, tenant_id, name, slug, timezone)
      VALUES
        (${WORKSPACE_A}, ${TENANT_ID}, 'Project Workspace A', 'project-a', 'UTC'),
        (${WORKSPACE_B}, ${TENANT_ID}, 'Project Workspace B', 'project-b', 'UTC'),
        (${OTHER_WORKSPACE}, ${OTHER_TENANT_ID}, 'Other Project Workspace', 'other-project', 'UTC')
    `;
    await database`
      INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id, objective)
      VALUES
        (${PROJECT_A}, ${TENANT_ID}, ${WORKSPACE_A}, 'Alpha Project', ${OWNER_ID}, 'Alpha objective'),
        (${PROJECT_B}, ${TENANT_ID}, ${WORKSPACE_A}, 'Beta Project', ${STRATEGY_ID}, 'Beta objective'),
        (${PROJECT_C}, ${TENANT_ID}, ${WORKSPACE_B}, 'Gamma Project', ${OWNER_ID}, 'Gamma objective'),
        (${OTHER_PROJECT}, ${OTHER_TENANT_ID}, ${OTHER_WORKSPACE}, 'Hidden Project', ${OTHER_OWNER_ID}, 'Hidden')
    `;
  });

  afterAll(async () => {
    await application?.close();
    await client?.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = originalDatabaseUrl;
  });

  it('creates projects idempotently with active owner, workspace scope, and strategy permission', async () => {
    const database = requireClient(client);
    const server = requireServer(application);
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    const payload = {
      end_date: '2027-06-30',
      name: 'New Strategy Project',
      objective: 'Build an evidence-led content program',
      owner_id: VIEWER_ID,
      start_date: '2027-01-01',
      workspace_id: WORKSPACE_A,
    };
    const headers = { ...writeHeaders(strategy), 'idempotency-key': 'project-create-001' };
    const first = await server.inject({ headers, method: 'POST', payload, url: API_PATH });
    const replay = await server.inject({ headers, method: 'POST', payload, url: API_PATH });
    expect(first.statusCode).toBe(201);
    expect(first.headers.etag).toBe('"1"');
    expect(replay.json().data.id).toBe(first.json().data.id);
    expect(
      await database`SELECT id FROM audit_events WHERE action = 'project.created'`,
    ).toHaveLength(1);

    const forgedOwner = await server.inject({
      headers: { ...writeHeaders(strategy), 'idempotency-key': 'project-create-002' },
      method: 'POST',
      payload: { ...payload, name: 'Forged owner', owner_id: OTHER_OWNER_ID },
      url: API_PATH,
    });
    expect(forgedOwner.statusCode).toBe(404);

    const invalidDates = await server.inject({
      headers: { ...writeHeaders(strategy), 'idempotency-key': 'project-create-003' },
      method: 'POST',
      payload: { ...payload, end_date: '2026-01-01', start_date: '2027-01-01' },
      url: API_PATH,
    });
    expect(invalidDates.statusCode).toBe(422);

    const content = await createSession(database, CONTENT_ID, TENANT_ID);
    const forbidden = await server.inject({
      headers: { ...writeHeaders(content), 'idempotency-key': 'project-create-004' },
      method: 'POST',
      payload,
      url: API_PATH,
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('PERMISSION_DENIED');
  });

  it('enforces workspace and project scope on create, list, and tenant-hiding reads', async () => {
    const database = requireClient(client);
    const server = requireServer(application);
    await database`
      INSERT INTO workspace_memberships (workspace_id, user_id, scope_json)
      VALUES (
        ${WORKSPACE_A},
        ${STRATEGY_ID},
        ${JSON.stringify({ project_ids: [PROJECT_A], schema_version: 'workspace-scope@1' })}::text::jsonb
      )
    `;
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    const scoped = await server.inject({
      headers: readHeaders(strategy),
      method: 'GET',
      url: API_PATH,
    });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json().data.map((item: { id: string }) => item.id)).toEqual([PROJECT_A]);

    const hiddenProject = await server.inject({
      headers: readHeaders(strategy),
      method: 'GET',
      url: `${API_PATH}/${PROJECT_B}`,
    });
    expect(hiddenProject.statusCode).toBe(404);
    const forgedTenant = await server.inject({
      headers: readHeaders(strategy),
      method: 'GET',
      url: `${API_PATH}/${OTHER_PROJECT}`,
    });
    expect(forgedTenant.statusCode).toBe(404);

    const createDenied = await server.inject({
      headers: { ...writeHeaders(strategy), 'idempotency-key': 'project-scope-create' },
      method: 'POST',
      payload: {
        name: 'Scope denied',
        owner_id: OWNER_ID,
        workspace_id: WORKSPACE_A,
      },
      url: API_PATH,
    });
    expect(createDenied.statusCode).toBe(404);
  });

  it('paginates and filters without losing PostgreSQL timestamp precision', async () => {
    const database = requireClient(client);
    const server = requireServer(application);
    const viewer = await createSession(database, VIEWER_ID, TENANT_ID);
    const first = await server.inject({
      headers: readHeaders(viewer),
      method: 'GET',
      url: `${API_PATH}?limit=1&workspace_id=${WORKSPACE_A}`,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toHaveLength(1);
    const second = await server.inject({
      headers: readHeaders(viewer),
      method: 'GET',
      url: `${API_PATH}?limit=1&workspace_id=${WORKSPACE_A}&cursor=${encodeURIComponent(first.json().meta.next_cursor)}`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().data).toHaveLength(1);
    expect(second.json().data[0].id).not.toBe(first.json().data[0].id);
  });

  it('updates owners and dates with versioning, then applies one-way guarded archival', async () => {
    const database = requireClient(client);
    const server = requireServer(application);
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    const headers = {
      ...writeHeaders(strategy),
      'idempotency-key': 'project-update-001',
      'if-match': '"1"',
    };
    const updated = await server.inject({
      headers,
      method: 'PATCH',
      payload: { end_date: '2027-12-31', owner_id: VIEWER_ID, start_date: '2027-01-01' },
      url: `${API_PATH}/${PROJECT_A}`,
    });
    const replay = await server.inject({
      headers,
      method: 'PATCH',
      payload: { end_date: '2027-12-31', owner_id: VIEWER_ID, start_date: '2027-01-01' },
      url: `${API_PATH}/${PROJECT_A}`,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data).toMatchObject({ owner_id: VIEWER_ID, version: 2 });
    expect(replay.json().data.version).toBe(2);

    const stale = await server.inject({
      headers: {
        ...writeHeaders(strategy),
        'idempotency-key': 'project-update-002',
        'if-match': '1',
      },
      method: 'PATCH',
      payload: { name: 'Stale name' },
      url: `${API_PATH}/${PROJECT_A}`,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');

    await database`
      INSERT INTO generation_runs (
        tenant_id, workspace_id, project_id, skill_name, skill_version,
        prompt_version_id, model_key, input_hash, request_id, status, started_at
      ) VALUES (
        ${TENANT_ID}, ${WORKSPACE_A}, ${PROJECT_A}, 'topic-planner', '1.0.0',
        ${'50000000-0000-4000-8000-000000000023'}, 'mock-model', ${'a'.repeat(64)},
        'project-archive-guard', 'running', now()
      )
    `;
    const blockedArchive = await server.inject({
      headers: {
        ...writeHeaders(strategy),
        'idempotency-key': 'project-archive-001',
        'if-match': '2',
      },
      method: 'PATCH',
      payload: { status: 'archived' },
      url: `${API_PATH}/${PROJECT_A}`,
    });
    expect(blockedArchive.statusCode).toBe(409);
    expect(blockedArchive.json().error.code).toBe('STATE_TRANSITION_INVALID');

    await database`
      UPDATE generation_runs SET status = 'failed', finished_at = now()
      WHERE request_id = 'project-archive-guard'
    `;
    const archived = await server.inject({
      headers: {
        ...writeHeaders(strategy),
        'idempotency-key': 'project-archive-002',
        'if-match': '2',
      },
      method: 'PATCH',
      payload: { status: 'archived' },
      url: `${API_PATH}/${PROJECT_A}`,
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().data).toMatchObject({ status: 'archived', version: 3 });
    expect(
      await database`SELECT id FROM audit_events WHERE action = 'project.archived'`,
    ).toHaveLength(1);

    const archivedEdit = await server.inject({
      headers: {
        ...writeHeaders(strategy),
        'idempotency-key': 'project-update-003',
        'if-match': '3',
      },
      method: 'PATCH',
      payload: { name: 'Cannot edit archive' },
      url: `${API_PATH}/${PROJECT_A}`,
    });
    expect(archivedEdit.statusCode).toBe(409);
    expect(archivedEdit.json().error.code).toBe('STATE_TRANSITION_INVALID');

    const combinedArchive = await server.inject({
      headers: {
        ...writeHeaders(strategy),
        'idempotency-key': 'project-archive-003',
        'if-match': '1',
      },
      method: 'PATCH',
      payload: { name: 'Combined', status: 'archived' },
      url: `${API_PATH}/${PROJECT_B}`,
    });
    expect(combinedArchive.statusCode).toBe(422);
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
  if (!application) throw new Error('Project test application was not initialized');
  return application.getHttpAdapter().getInstance();
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Project test PostgreSQL client was not initialized');
  return client;
}
