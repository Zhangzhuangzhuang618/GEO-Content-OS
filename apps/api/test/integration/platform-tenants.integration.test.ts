import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import type { EmailAdapter } from '@geo-content-os/adapter-email';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createHash, randomBytes } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApplication } from '../../src/application.js';
import { migrateDatabase } from '../../src/database/migrate.js';
import { IdentityAuthDatabase } from '../../src/modules/identity/auth/auth.database.js';
import { PlatformTenantService } from '../../src/modules/platform-tenants/platform-tenant.service.js';

const ADMIN = '10000000-0000-4000-8000-000000000102';
const OWNER = '11000000-0000-4000-8000-000000000102';
const TENANT = '20000000-0000-4000-8000-000000000102';

describe('platform tenant API', () => {
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
      TRUNCATE usage_ledger, workspaces, audit_events, support_access_grants,
        idempotency_records, invitations, sessions, platform_roles, memberships,
        tenants, users CASCADE
    `;
    await database`
      INSERT INTO users (id,email,password_hash,display_name,status) VALUES
        (${ADMIN},'admin@example.com','not-used','Platform Admin','active'),
        (${OWNER},'owner@example.com','not-used','Tenant Owner','active')
    `;
    await database`
      INSERT INTO platform_roles (user_id,role_code,status)
      VALUES (${ADMIN},'platform_admin','active')
    `;
    await database`
      INSERT INTO tenants (id,name,slug,plan_code,status)
      VALUES (${TENANT},'Existing Tenant','existing-tenant','pro','active')
    `;
    await database`
      INSERT INTO memberships (tenant_id,user_id,role_code,status)
      VALUES (${TENANT},${OWNER},'tenant_owner','active')
    `;
  });

  afterAll(async () => {
    await application?.close();
    await client?.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = originalDatabaseUrl;
  });

  it('creates the tenant boundary atomically and replays the global idempotent response', async () => {
    const database = requireClient(client);
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const admin = await createSession(database, ADMIN);
    const payload = {
      default_workspace_name: 'Acme Workspace',
      name: 'Acme China',
      owner_display_name: 'Acme Owner',
      owner_email: 'acme-owner@example.com',
      plan_code: 'enterprise',
      slug: 'acme-china',
      timezone: 'Asia/Shanghai',
    };
    const first = await server.inject({
      headers: { ...writeHeaders(admin), 'idempotency-key': 'tenant-create-102' },
      method: 'POST',
      payload,
      url: '/api/v1/platform/tenants',
    });
    const replay = await server.inject({
      headers: { ...writeHeaders(admin), 'idempotency-key': 'tenant-create-102' },
      method: 'POST',
      payload,
      url: '/api/v1/platform/tenants',
    });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().data.id).toBe(first.json().data.id);
    expect(first.json().data).toMatchObject({
      health: { status: 'healthy' },
      plan_code: 'enterprise',
      status: 'active',
      usage: { currency: 'CNY', ledger_entries: 0, settled_cost_cents: 0 },
      version: 1,
    });
    expect(first.headers['etag']).toBe('"1"');
    const tenantId = first.json().data.id as string;
    const boundary = await database<
      { invitations: number; memberships: number; owners: number; workspaces: number }[]
    >`
      SELECT
        (SELECT count(*)::integer FROM invitations WHERE tenant_id=${tenantId}) AS invitations,
        (SELECT count(*)::integer FROM memberships WHERE tenant_id=${tenantId} AND role_code='tenant_owner' AND status='invited') AS memberships,
        (SELECT count(*)::integer FROM users WHERE email='acme-owner@example.com' AND status='invited') AS owners,
        (SELECT count(*)::integer FROM workspaces WHERE tenant_id=${tenantId} AND slug='default') AS workspaces
    `;
    expect(boundary).toEqual([{ invitations: 1, memberships: 1, owners: 1, workspaces: 1 }]);
    expect(
      await database<{ action: string; tenantId: string | null }[]>`
        SELECT action,tenant_id AS "tenantId" FROM audit_events WHERE tenant_id=${tenantId}
      `,
    ).toEqual([{ action: 'platform.tenant.created', tenantId }]);
    expect(
      await database<{ tenantId: string | null }[]>`
        SELECT tenant_id AS "tenantId" FROM idempotency_records
        WHERE idempotency_key='tenant-create-102'
      `,
    ).toEqual([{ tenantId: null }]);
    expect(JSON.stringify(first.json())).not.toContain('token');
  });

  it('lists metadata and suspends and restores with optimistic locking', async () => {
    const database = requireClient(client);
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const admin = await createSession(database, ADMIN);
    const owner = await createSession(database, OWNER, TENANT);
    await insertUsage(database, 'platform-tenant-active-usage', 500, false);
    await insertUsage(database, 'platform-tenant-reversed-usage', 700, true);
    const listed = await server.inject({
      headers: readHeaders(admin),
      method: 'GET',
      url: '/api/v1/platform/tenants?search=Existing&status=active&plan_code=pro',
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data.items).toEqual([
      expect.objectContaining({
        id: TENANT,
        plan_code: 'pro',
        status: 'active',
        usage: expect.objectContaining({ ledger_entries: 1, settled_cost_cents: 500 }),
        version: 1,
      }),
    ]);
    expect(JSON.stringify(listed.json())).not.toContain('owner@example.com');

    const suspended = await server.inject({
      headers: { ...writeHeaders(admin), 'if-match': '"1"' },
      method: 'POST',
      payload: { reason: 'Payment overdue' },
      url: `/api/v1/platform/tenants/${TENANT}/suspend`,
    });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json().data).toMatchObject({
      health: { status: 'suspended' },
      status: 'suspended',
      version: 2,
    });
    expect(suspended.headers['etag']).toBe('"2"');
    const invalidTenantSession = await server.inject({
      headers: readHeaders(owner),
      method: 'GET',
      url: '/api/v1/auth/session',
    });
    expect(invalidTenantSession.statusCode).toBe(401);

    const stale = await server.inject({
      headers: { ...writeHeaders(admin), 'if-match': '"1"' },
      method: 'POST',
      url: `/api/v1/platform/tenants/${TENANT}/restore`,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');
    const restored = await server.inject({
      headers: { ...writeHeaders(admin), 'if-match': '"2"' },
      method: 'POST',
      url: `/api/v1/platform/tenants/${TENANT}/restore`,
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().data).toMatchObject({ status: 'active', version: 3 });
    expect(
      await database<{ action: string }[]>`
        SELECT action FROM audit_events WHERE tenant_id=${TENANT} ORDER BY created_at
      `,
    ).toEqual([{ action: 'platform.tenant.suspended' }, { action: 'platform.tenant.restored' }]);
  });

  it('replaces a pending owner invitation once and rejects resend after acceptance', async () => {
    const database = requireClient(client);
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const admin = await createSession(database, ADMIN);
    await database`
      INSERT INTO memberships (tenant_id,user_id,role_code,status)
      VALUES (${TENANT},${ADMIN},'tenant_owner','active')
    `;
    await database`
      UPDATE memberships
      SET status = 'invited', invited_by = ${ADMIN}
      WHERE tenant_id = ${TENANT} AND user_id = ${OWNER}
    `;
    const workspaces = await database<{ id: string }[]>`
      INSERT INTO workspaces (tenant_id,name,slug,timezone,settings_json,status)
      VALUES (${TENANT},'Default Workspace','default','Asia/Shanghai','{}'::jsonb,'active')
      RETURNING id
    `;
    const workspace = workspaces[0];
    if (!workspace) throw new Error('Invitation resend test workspace was not created');
    const invitations = await database<{ id: string }[]>`
      INSERT INTO invitations (
        tenant_id,email,role_code,workspace_scope_json,token_hash,expires_at,invited_by
      ) VALUES (
        ${TENANT},'owner@example.com','tenant_owner',
        ${database.json({ workspace_ids: [workspace.id] })},${'a'.repeat(64)},
        now() + interval '1 hour',${ADMIN}
      )
      RETURNING id
    `;
    const original = invitations[0];
    if (!original) throw new Error('Invitation resend test invitation was not created');

    const headers = {
      ...writeHeaders(admin),
      'idempotency-key': 'tenant-owner-invitation-resend-102',
    };
    const first = await server.inject({
      headers,
      method: 'POST',
      url: `/api/v1/platform/tenants/${TENANT}/owner-invitation/resend`,
    });
    const replay = await server.inject({
      headers,
      method: 'POST',
      url: `/api/v1/platform/tenants/${TENANT}/owner-invitation/resend`,
    });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.id).toBe(TENANT);
    expect(JSON.stringify(first.json())).not.toContain('owner@example.com');
    expect(JSON.stringify(first.json())).not.toContain('token');

    const history = await database<
      { acceptedAt: Date | null; id: string; revokedAt: Date | null; tokenHash: string }[]
    >`
      SELECT
        id,
        accepted_at AS "acceptedAt",
        revoked_at AS "revokedAt",
        token_hash AS "tokenHash"
      FROM invitations
      WHERE tenant_id = ${TENANT}
      ORDER BY created_at, id
    `;
    expect(history).toHaveLength(2);
    expect(history.find((row) => row.id === original.id)?.revokedAt).not.toBeNull();
    const current = history.find((row) => row.id !== original.id);
    expect(current).toMatchObject({ acceptedAt: null, revokedAt: null });
    expect(current?.tokenHash).not.toBe('a'.repeat(64));
    expect(
      await database<{ action: string }[]>`
        SELECT action FROM audit_events WHERE tenant_id = ${TENANT} ORDER BY created_at
      `,
    ).toEqual([{ action: 'platform.tenant.owner_invitation_resent' }]);

    await database`
      UPDATE memberships SET status = 'active'
      WHERE tenant_id = ${TENANT} AND user_id = ${OWNER}
    `;
    const accepted = await server.inject({
      headers: {
        ...writeHeaders(admin),
        'idempotency-key': 'tenant-owner-invitation-resend-after-accept-102',
      },
      method: 'POST',
      url: `/api/v1/platform/tenants/${TENANT}/owner-invitation/resend`,
    });
    expect(accepted.statusCode).toBe(409);
    expect(accepted.json().error.code).toBe('STATE_TRANSITION_INVALID');
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM invitations WHERE tenant_id = ${TENANT}
      `,
    ).toEqual([{ count: 2 }]);
  });

  it('keeps the previous invitation pending when resend email delivery fails', async () => {
    const database = requireClient(client);
    const app = requireApplication(application);
    await database`
      INSERT INTO memberships (tenant_id,user_id,role_code,status)
      VALUES (${TENANT},${ADMIN},'tenant_owner','active')
    `;
    await database`
      UPDATE memberships
      SET status = 'invited', invited_by = ${ADMIN}
      WHERE tenant_id = ${TENANT} AND user_id = ${OWNER}
    `;
    const workspaces = await database<{ id: string }[]>`
      INSERT INTO workspaces (tenant_id,name,slug,timezone,settings_json,status)
      VALUES (${TENANT},'Default Workspace','default','Asia/Shanghai','{}'::jsonb,'active')
      RETURNING id
    `;
    const workspace = workspaces[0];
    if (!workspace) throw new Error('Invitation rollback test workspace was not created');
    const invitations = await database<{ id: string }[]>`
      INSERT INTO invitations (
        tenant_id,email,role_code,workspace_scope_json,token_hash,expires_at,invited_by
      ) VALUES (
        ${TENANT},'owner@example.com','tenant_owner',
        ${database.json({ workspace_ids: [workspace.id] })},${'b'.repeat(64)},
        now() + interval '1 hour',${ADMIN}
      )
      RETURNING id
    `;
    const original = invitations[0];
    if (!original) throw new Error('Invitation rollback test invitation was not created');
    const failingEmailAdapter: EmailAdapter = {
      sendInvitation: () => Promise.reject(new Error('Email delivery failed')),
      sendPasswordReset: () => Promise.reject(new Error('Email delivery failed')),
    };
    const service = new PlatformTenantService(app.get(IdentityAuthDatabase), failingEmailAdapter);

    await expect(
      database.begin((transaction) =>
        service.resendOwnerInvitation(transaction, ADMIN, TENANT, {
          requestId: 'owner-invitation-resend-email-failed',
        }),
      ),
    ).rejects.toThrow('Email delivery failed');
    expect(
      await database<{ id: string; revokedAt: Date | null; tokenHash: string }[]>`
        SELECT id, revoked_at AS "revokedAt", token_hash AS "tokenHash"
        FROM invitations WHERE tenant_id = ${TENANT}
      `,
    ).toEqual([{ id: original.id, revokedAt: null, tokenHash: 'b'.repeat(64) }]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM audit_events WHERE tenant_id = ${TENANT}
      `,
    ).toEqual([{ count: 0 }]);
  });

  it('denies tenant owners and rejects archived transitions', async () => {
    const database = requireClient(client);
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const owner = await createSession(database, OWNER, TENANT);
    const forbidden = await server.inject({
      headers: readHeaders(owner),
      method: 'GET',
      url: '/api/v1/platform/tenants',
    });
    expect(forbidden.statusCode).toBe(403);

    await database`UPDATE tenants SET status='archived' WHERE id=${TENANT}`;
    const admin = await createSession(database, ADMIN);
    const restore = await server.inject({
      headers: { ...writeHeaders(admin), 'if-match': '"1"' },
      method: 'POST',
      url: `/api/v1/platform/tenants/${TENANT}/restore`,
    });
    expect(restore.statusCode).toBe(409);
    expect(restore.json().error.code).toBe('STATE_TRANSITION_INVALID');
  });
});

async function createSession(database: Sql, userId: string, tenantId?: string) {
  const session = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  await database`
    INSERT INTO sessions (user_id,active_tenant_id,session_hash,csrf_hash,expires_at)
    VALUES (
      ${userId},${tenantId ?? null},${sha256(session)},${sha256(csrf)},now()+interval '1 hour'
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

async function insertUsage(database: Sql, requestId: string, costCents: number, reverse: boolean) {
  await database`
    INSERT INTO usage_ledger (
      tenant_id,request_id,cost_category,quantity,unit,cost_cents,currency,status
    ) VALUES (
      ${TENANT},${requestId},'manual_adjustment',1,'request',${costCents},'CNY','estimated'
    )
  `;
  const settlements = await database<{ id: string }[]>`
    INSERT INTO usage_ledger (
      tenant_id,request_id,cost_category,quantity,unit,cost_cents,currency,status
    ) VALUES (
      ${TENANT},${requestId},'manual_adjustment',1,'request',${costCents},'CNY','settled'
    )
    RETURNING id
  `;
  if (!reverse) return;
  const settlement = settlements[0];
  if (!settlement) throw new Error('Platform tenant usage settlement was not created');
  await database`
    INSERT INTO usage_ledger (
      tenant_id,request_id,cost_category,quantity,unit,cost_cents,currency,status,
      reverses_ledger_id
    ) VALUES (
      ${TENANT},${`${requestId}-reversal`},'manual_adjustment',1,'request',
      ${-costCents},'CNY','reversed',${settlement.id}
    )
  `;
}

function requireApplication(value: NestFastifyApplication | undefined) {
  if (!value) throw new Error('Platform tenant test application was not initialized');
  return value;
}

function requireClient(value: Sql | undefined) {
  if (!value) throw new Error('Platform tenant test PostgreSQL client was not initialized');
  return value;
}
