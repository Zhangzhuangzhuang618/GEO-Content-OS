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

const OWNER = '10000000-0000-4000-8000-000000000098';
const SECOND_OWNER = '11000000-0000-4000-8000-000000000098';
const ADMIN = '12000000-0000-4000-8000-000000000098';
const VIEWER = '13000000-0000-4000-8000-000000000098';
const OTHER_OWNER = '14000000-0000-4000-8000-000000000098';
const TENANT = '20000000-0000-4000-8000-000000000098';
const OTHER_TENANT = '21000000-0000-4000-8000-000000000098';
const WORKSPACE = '30000000-0000-4000-8000-000000000098';
const OTHER_WORKSPACE = '31000000-0000-4000-8000-000000000098';

describe('memberships API', () => {
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
      TRUNCATE workspace_memberships, workspaces, audit_events, invitations, sessions,
        platform_roles, memberships, tenants, users CASCADE
    `;
    await database`
      INSERT INTO users (id,email,display_name,status) VALUES
        (${OWNER},'owner@example.com','Owner','active'),
        (${SECOND_OWNER},'second-owner@example.com','Second Owner','active'),
        (${ADMIN},'admin@example.com','Admin','active'),
        (${VIEWER},'viewer@example.com','Viewer','active'),
        (${OTHER_OWNER},'other@example.com','Other Owner','active')
    `;
    await database`
      INSERT INTO tenants (id,name,slug,status) VALUES
        (${TENANT},'Member Tenant','member-tenant','active'),
        (${OTHER_TENANT},'Other Tenant','other-member-tenant','active')
    `;
    await database`
      INSERT INTO memberships (tenant_id,user_id,role_code,status) VALUES
        (${TENANT},${OWNER},'tenant_owner','active'),
        (${TENANT},${ADMIN},'tenant_admin','active'),
        (${TENANT},${VIEWER},'viewer','active'),
        (${OTHER_TENANT},${OTHER_OWNER},'tenant_owner','active')
    `;
    await database`
      INSERT INTO workspaces (id,tenant_id,name,slug,timezone,status) VALUES
        (${WORKSPACE},${TENANT},'Member Workspace','member-workspace','UTC','active'),
        (${OTHER_WORKSPACE},${OTHER_TENANT},'Other Workspace','other-member-workspace','UTC','active')
    `;
  });

  afterAll(async () => {
    await application?.close();
    await client?.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = originalDatabaseUrl;
  });

  it('lists only the active tenant and exposes workspace scope with version', async () => {
    const database = requireClient(client);
    await database`
      INSERT INTO workspace_memberships (workspace_id,user_id,scope_json)
      VALUES (${WORKSPACE},${VIEWER},'{"schema_version":"workspace-scope@1"}'::jsonb)
    `;
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const owner = await createSession(database, OWNER, TENANT);
    const response = await server.inject({
      headers: readHeaders(owner),
      method: 'GET',
      url: '/api/v1/memberships?search=viewer&status=active',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        items: [
          {
            email: 'viewer@example.com',
            role_code: 'viewer',
            tenant_id: TENANT,
            version: 1,
            workspace_scope: { workspace_ids: [WORKSPACE] },
          },
        ],
        next_cursor: null,
      },
    });
    expect(JSON.stringify(response.json())).not.toContain(OTHER_TENANT);

    const viewer = await createSession(database, VIEWER, TENANT);
    const forbidden = await server.inject({
      headers: readHeaders(viewer),
      method: 'GET',
      url: '/api/v1/memberships',
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('updates role and workspace scope with version, authorization, idempotency and audit', async () => {
    const database = requireClient(client);
    const [target] = await database<{ id: string }[]>`
      SELECT id FROM memberships WHERE tenant_id = ${TENANT} AND user_id = ${VIEWER}
    `;
    if (!target) throw new Error('Missing membership fixture');
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const owner = await createSession(database, OWNER, TENANT);
    const payload = {
      role_code: 'reviewer',
      workspace_scope: { workspace_ids: [WORKSPACE] },
    };
    const first = await server.inject({
      headers: {
        ...writeHeaders(owner),
        'idempotency-key': 'membership-update-viewer',
        'if-match': '"1"',
      },
      method: 'PATCH',
      payload,
      url: `/api/v1/memberships/${target.id}`,
    });
    const replay = await server.inject({
      headers: {
        ...writeHeaders(owner),
        'idempotency-key': 'membership-update-viewer',
        'if-match': '"1"',
      },
      method: 'PATCH',
      payload,
      url: `/api/v1/memberships/${target.id}`,
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers['etag']).toBe('"2"');
    expect(first.json().data).toMatchObject({
      role_code: 'reviewer',
      version: 2,
      workspace_scope: { workspace_ids: [WORKSPACE] },
    });
    expect(replay.json().data.version).toBe(2);
    expect(
      await database<{ action: string }[]>`
        SELECT action FROM audit_events WHERE resource_id = ${target.id}
      `,
    ).toEqual([{ action: 'membership.updated' }]);

    const stale = await server.inject({
      headers: {
        ...writeHeaders(owner),
        'idempotency-key': 'membership-update-stale',
        'if-match': '"1"',
      },
      method: 'PATCH',
      payload: { role_code: 'analyst' },
      url: `/api/v1/memberships/${target.id}`,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');

    const admin = await createSession(database, ADMIN, TENANT);
    const [ownerMembership] = await database<{ id: string }[]>`
      SELECT id FROM memberships WHERE tenant_id = ${TENANT} AND user_id = ${OWNER}
    `;
    if (!ownerMembership) throw new Error('Missing owner membership fixture');
    const forbidden = await server.inject({
      headers: {
        ...writeHeaders(admin),
        'idempotency-key': 'admin-demote-owner',
        'if-match': '"1"',
      },
      method: 'PATCH',
      payload: { role_code: 'viewer' },
      url: `/api/v1/memberships/${ownerMembership.id}`,
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('disables and restores members but preserves one owner under concurrent writes', async () => {
    const database = requireClient(client);
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const ownerSession = await createSession(database, OWNER, TENANT);
    const [viewerMembership] = await database<{ id: string }[]>`
      SELECT id FROM memberships WHERE tenant_id = ${TENANT} AND user_id = ${VIEWER}
    `;
    if (!viewerMembership) throw new Error('Missing viewer membership fixture');
    const disabled = await server.inject({
      headers: { ...writeHeaders(ownerSession), 'if-match': '"1"' },
      method: 'POST',
      payload: { reason: 'Access no longer required' },
      url: `/api/v1/memberships/${viewerMembership.id}/disable`,
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().data).toMatchObject({ status: 'disabled', version: 2 });
    const restored = await server.inject({
      headers: { ...writeHeaders(ownerSession), 'if-match': '"2"' },
      method: 'POST',
      url: `/api/v1/memberships/${viewerMembership.id}/restore`,
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().data).toMatchObject({ status: 'active', version: 3 });

    const [ownerMembership] = await database<{ id: string }[]>`
      SELECT id FROM memberships WHERE tenant_id = ${TENANT} AND user_id = ${OWNER}
    `;
    if (!ownerMembership) throw new Error('Missing owner membership fixture');
    const lastOwner = await server.inject({
      headers: { ...writeHeaders(ownerSession), 'if-match': '"1"' },
      method: 'POST',
      payload: { reason: 'Must be rejected' },
      url: `/api/v1/memberships/${ownerMembership.id}/disable`,
    });
    expect(lastOwner.statusCode).toBe(409);
    expect(lastOwner.json().error.code).toBe('STATE_TRANSITION_INVALID');
    await expect(
      database`UPDATE memberships SET role_code = 'viewer' WHERE id = ${ownerMembership.id}`,
    ).rejects.toThrow(/last active tenant_owner/u);

    await database`
      INSERT INTO memberships (tenant_id,user_id,role_code,status)
      VALUES (${TENANT},${SECOND_OWNER},'tenant_owner','active')
    `;
    const owners = await database<{ id: string }[]>`
      SELECT id FROM memberships
      WHERE tenant_id = ${TENANT} AND role_code = 'tenant_owner' AND status = 'active'
      ORDER BY id
    `;
    const attempts = await Promise.allSettled(
      owners.map((membership) =>
        database.begin(
          (transaction) =>
            transaction`UPDATE memberships SET status = 'disabled' WHERE id = ${membership.id}`,
        ),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM memberships
        WHERE tenant_id = ${TENANT} AND role_code = 'tenant_owner' AND status = 'active'
      `,
    ).toEqual([{ count: 1 }]);
  });

  it('lists pending and expired invitations with expiry without exposing tokens', async () => {
    const database = requireClient(client);
    await database`
      INSERT INTO invitations (
        tenant_id,email,role_code,token_hash,created_at,expires_at,invited_by
      ) VALUES
        (${TENANT},'pending@example.com','viewer',${sha256('pending-token')},now(),now()+interval '1 day',${OWNER}),
        (${TENANT},'expired@example.com','analyst',${sha256('expired-token')},now()-interval '2 days',now()-interval '1 day',${OWNER}),
        (${OTHER_TENANT},'hidden@example.com','viewer',${sha256('hidden-token')},now(),now()+interval '1 day',${OTHER_OWNER})
    `;
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const owner = await createSession(database, OWNER, TENANT);
    const response = await server.inject({
      headers: readHeaders(owner),
      method: 'GET',
      url: '/api/v1/invitations',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ email: 'pending@example.com', status: 'pending' }),
        expect.objectContaining({ email: 'expired@example.com', status: 'expired' }),
      ]),
    );
    expect(JSON.stringify(response.json())).not.toContain('token');
    expect(JSON.stringify(response.json())).not.toContain('hidden@example.com');
  });
});

async function createSession(database: Sql, userId: string, tenantId: string) {
  const session = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  await database`
    INSERT INTO sessions (user_id,active_tenant_id,session_hash,csrf_hash,expires_at)
    VALUES (${userId},${tenantId},${sha256(session)},${sha256(csrf)},now()+interval '1 hour')
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

function requireApplication(value: NestFastifyApplication | undefined) {
  if (!value) throw new Error('Membership test application was not initialized');
  return value;
}

function requireClient(value: Sql | undefined) {
  if (!value) throw new Error('Membership test PostgreSQL client was not initialized');
  return value;
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
