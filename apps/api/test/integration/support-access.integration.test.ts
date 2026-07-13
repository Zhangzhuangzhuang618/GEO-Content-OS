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
import {
  SupportAccessNotFoundError,
  SupportAccessService,
} from '../../src/modules/platform-access/index.js';

const GRANTOR_ID = '10000000-0000-4000-8000-000000000019';
const SUPPORT_ID = '10000000-0000-4000-8000-000000000119';
const OPERATOR_ID = '10000000-0000-4000-8000-000000000219';
const TENANT_ID = '20000000-0000-4000-8000-000000000019';
const OTHER_TENANT_ID = '20000000-0000-4000-8000-000000000119';
const API_PATH = '/api/v1/platform/support-access-grants';

describe('time-limited platform support access', () => {
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
    await database`TRUNCATE audit_events, support_access_grants, idempotency_records, sessions, platform_roles, memberships, tenants, users CASCADE`;
    await database`
      INSERT INTO users (id, email, display_name, status)
      VALUES
        (${GRANTOR_ID}, 'grantor@example.com', 'Grantor Admin', 'active'),
        (${SUPPORT_ID}, 'support@example.com', 'Support Admin', 'active'),
        (${OPERATOR_ID}, 'operator@example.com', 'Platform Operator', 'active')
    `;
    await database`
      INSERT INTO tenants (id, name, slug, status)
      VALUES
        (${TENANT_ID}, 'Support Target', 'support-target', 'active'),
        (${OTHER_TENANT_ID}, 'Other Target', 'other-target', 'active')
    `;
    await database`
      INSERT INTO platform_roles (user_id, role_code, status)
      VALUES
        (${GRANTOR_ID}, 'platform_admin', 'active'),
        (${SUPPORT_ID}, 'platform_admin', 'active'),
        (${OPERATOR_ID}, 'platform_operator', 'active')
    `;
  });

  afterAll(async () => {
    await application?.close();
    await client?.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = originalDatabaseUrl;
  });

  it('enforces the eight-hour ceiling and append-only histories in PostgreSQL', async () => {
    const database = requireClient(client);
    const scope = supportScope();
    await expect(
      database`
        INSERT INTO support_access_grants (
          tenant_id, platform_user_id, scope_json, reason, expires_at, granted_by
        ) VALUES (
          ${TENANT_ID}, ${SUPPORT_ID}, ${JSON.stringify(scope)}::text::jsonb,
          'Too long', now() + interval '8 hours 1 second', ${GRANTOR_ID}
        )
      `,
    ).rejects.toThrow(/support_access_grants_expiry_check/u);
    await expect(
      database`
        INSERT INTO support_access_grants (
          tenant_id, platform_user_id, scope_json, reason, expires_at, granted_by
        ) VALUES (
          ${TENANT_ID}, ${SUPPORT_ID}, ${JSON.stringify({})}::text::jsonb,
          'Bad scope', now() + interval '1 hour', ${GRANTOR_ID}
        )
      `,
    ).rejects.toThrow(/support_access_grants_scope_check/u);

    const grantId = await insertGrant(database);
    await expect(
      database`UPDATE support_access_grants SET reason = 'Changed' WHERE id = ${grantId}`,
    ).rejects.toThrow(/identity and scope are immutable/u);
    await expect(database`DELETE FROM support_access_grants WHERE id = ${grantId}`).rejects.toThrow(
      /append-only/u,
    );
    await database`UPDATE support_access_grants SET revoked_at = now() WHERE id = ${grantId}`;
    await expect(
      database`UPDATE support_access_grants SET revoked_at = now() WHERE id = ${grantId}`,
    ).rejects.toThrow(/one-way revocation/u);

    const [audit] = await database<{ id: string }[]>`
      INSERT INTO audit_events (
        tenant_id, actor_id, support_access_grant_id, action, resource_type, request_id
      ) VALUES (
        ${TENANT_ID}, ${SUPPORT_ID}, ${grantId}, 'support.read', 'tenant', 'history-test'
      )
      RETURNING id
    `;
    if (!audit) throw new Error('Expected audit fixture');
    await expect(
      database`UPDATE audit_events SET action = 'changed' WHERE id = ${audit.id}`,
    ).rejects.toThrow(/append-only/u);
    await expect(database`DELETE FROM audit_events WHERE id = ${audit.id}`).rejects.toThrow(
      /append-only/u,
    );
  });

  it('creates one audited grant idempotently and rejects unauthorized or invalid targets', async () => {
    const database = requireClient(client);
    const server = requireServer(application);
    const grantor = await createSession(database, GRANTOR_ID);
    const payload = grantPayload();
    const first = await createGrantRequest(server, grantor, 'grant-support-1', payload);
    expect(first.statusCode).toBe(201);
    expect(first.json().data).toMatchObject({
      granted_by: GRANTOR_ID,
      platform_user_id: SUPPORT_ID,
      status: 'active',
      tenant_id: TENANT_ID,
    });

    await database`
      UPDATE platform_roles SET status = 'disabled'
      WHERE user_id = ${SUPPORT_ID} AND role_code = 'platform_admin'
    `;
    const replay = await createGrantRequest(server, grantor, 'grant-support-1', payload);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().data.id).toBe(first.json().data.id);
    const counts = await database<{ audits: number; grants: number }[]>`
      SELECT
        (SELECT count(*)::integer FROM support_access_grants) AS grants,
        (SELECT count(*)::integer FROM audit_events) AS audits
    `;
    expect(counts[0]).toEqual({ audits: 1, grants: 1 });

    const conflict = await createGrantRequest(server, grantor, 'grant-support-1', {
      ...payload,
      reason: 'Changed body',
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');

    const missingKey = await server.inject({
      headers: writeHeaders(grantor),
      method: 'POST',
      payload,
      url: API_PATH,
    });
    expect(missingKey.statusCode).toBe(422);
    expect(missingKey.json().error.code).toBe('SCHEMA_VALIDATION_FAILED');

    const operator = await createSession(database, OPERATOR_ID);
    const forbidden = await createGrantRequest(server, operator, 'operator-grant', payload);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('PERMISSION_DENIED');

    const invalidTarget = await createGrantRequest(server, grantor, 'invalid-target', {
      ...payload,
      platform_user_id: OPERATOR_ID,
    });
    expect(invalidTarget.statusCode).toBe(404);
    expect(invalidTarget.json().error.code).toBe('RESOURCE_NOT_FOUND');

    const tooLong = await createGrantRequest(server, grantor, 'too-long', {
      ...payload,
      expires_at: new Date(Date.now() + 8 * 60 * 60 * 1_000 + 60_000).toISOString(),
    });
    expect(tooLong.statusCode).toBe(422);
    expect(tooLong.json().error.code).toBe('SCHEMA_VALIDATION_FAILED');
  });

  it('requires a matching live grant and records every tenant operation atomically', async () => {
    const database = requireClient(client);
    const service = requireApplication(application).get(SupportAccessService);
    const grantId = await insertGrant(database);
    const result = await service.withTenantAccess(
      accessInput(grantId, 'support.tenant.read', 'read-1'),
      async (transaction, context) => {
        const rows = await transaction<{ name: string }[]>`
          SELECT name FROM tenants WHERE id = ${context.tenantId}
        `;
        return rows[0]?.name;
      },
    );
    expect(result).toBe('Support Target');
    expect(await auditCount(database, 'support.tenant.read')).toBe(1);

    await expect(
      service.withTenantAccess(
        { ...accessInput(grantId, 'support.denied', 'denied-1'), permission: 'audit.read' },
        async () => 'unreachable',
      ),
    ).rejects.toBeInstanceOf(SupportAccessNotFoundError);
    await expect(
      service.withTenantAccess(
        { ...accessInput(grantId, 'support.denied', 'denied-2'), resourceType: 'secret' },
        async () => 'unreachable',
      ),
    ).rejects.toBeInstanceOf(SupportAccessNotFoundError);
    expect(await auditCount(database, 'support.denied')).toBe(0);

    await expect(
      service.withTenantAccess(
        accessInput(grantId, 'support.tenant.failed', 'failed-1'),
        async (transaction) => {
          await transaction`UPDATE tenants SET name = 'Must Roll Back' WHERE id = ${TENANT_ID}`;
          throw new Error('operation failed');
        },
      ),
    ).rejects.toThrow('operation failed');
    const tenant = await database<{ name: string }[]>`
      SELECT name FROM tenants WHERE id = ${TENANT_ID}
    `;
    expect(tenant[0]?.name).toBe('Support Target');
    expect(await auditCount(database, 'support.tenant.failed')).toBe(0);
  });

  it('invalidates access immediately after revocation, expiry, role disablement, or suspension', async () => {
    const database = requireClient(client);
    const service = requireApplication(application).get(SupportAccessService);
    const revokedGrant = await insertGrant(database);
    await service.revokeGrant(GRANTOR_ID, revokedGrant, {
      requestId: 'revoke-1',
    });
    await expect(
      service.withTenantAccess(
        accessInput(revokedGrant, 'support.after-revoke', 'after-revoke'),
        async () => 'unreachable',
      ),
    ).rejects.toBeInstanceOf(SupportAccessNotFoundError);
    expect(await auditCount(database, 'support_access.grant.revoked')).toBe(1);

    const expiredGrant = await insertGrant(database, 'expired');
    await expect(
      service.withTenantAccess(
        accessInput(expiredGrant, 'support.after-expiry', 'after-expiry'),
        async () => 'unreachable',
      ),
    ).rejects.toBeInstanceOf(SupportAccessNotFoundError);

    const disabledGrant = await insertGrant(database);
    await database`
      UPDATE platform_roles SET status = 'disabled'
      WHERE user_id = ${SUPPORT_ID} AND role_code = 'platform_admin'
    `;
    await expect(
      service.withTenantAccess(
        accessInput(disabledGrant, 'support.after-disable', 'after-disable'),
        async () => 'unreachable',
      ),
    ).rejects.toBeInstanceOf(SupportAccessNotFoundError);
    await database`
      UPDATE platform_roles SET status = 'active'
      WHERE user_id = ${SUPPORT_ID} AND role_code = 'platform_admin'
    `;
    await database`UPDATE tenants SET status = 'suspended' WHERE id = ${TENANT_ID}`;
    await expect(
      service.withTenantAccess(
        accessInput(disabledGrant, 'support.after-suspend', 'after-suspend'),
        async () => 'unreachable',
      ),
    ).rejects.toBeInstanceOf(SupportAccessNotFoundError);
  });
});

function grantPayload() {
  return {
    expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    platform_user_id: SUPPORT_ID,
    reason: 'Investigate tenant support incident INC-19',
    scope: { permissions: ['content.read'], resource_types: ['tenant'] },
    tenant_id: TENANT_ID,
  };
}

function supportScope() {
  return {
    permissions: ['content.read'],
    resource_types: ['tenant'],
    schema_version: 'support-access@1',
  };
}

async function insertGrant(database: Sql, clock: 'active' | 'expired' = 'active'): Promise<string> {
  const scope = JSON.stringify(supportScope());
  const rows =
    clock === 'expired'
      ? await database<{ id: string }[]>`
          INSERT INTO support_access_grants (
            tenant_id, platform_user_id, scope_json, reason, expires_at, granted_by, created_at
          ) VALUES (
            ${TENANT_ID}, ${SUPPORT_ID}, ${scope}::text::jsonb, 'Support fixture',
            now() - interval '1 hour', ${GRANTOR_ID}, now() - interval '2 hours'
          )
          RETURNING id
        `
      : await database<{ id: string }[]>`
          INSERT INTO support_access_grants (
            tenant_id, platform_user_id, scope_json, reason, expires_at, granted_by
          ) VALUES (
            ${TENANT_ID}, ${SUPPORT_ID}, ${scope}::text::jsonb, 'Support fixture',
            now() + interval '1 hour', ${GRANTOR_ID}
          )
          RETURNING id
        `;
  const grant = rows[0];
  if (!grant) throw new Error('Expected support access grant fixture');
  return grant.id;
}

function accessInput(grantId: string, action: string, requestId: string) {
  return {
    action,
    actorUserId: SUPPORT_ID,
    grantId,
    permission: 'content.read' as const,
    requestId,
    resourceId: TENANT_ID,
    resourceType: 'tenant',
    tenantId: TENANT_ID,
  };
}

async function auditCount(database: Sql, action: string): Promise<number> {
  const rows = await database<{ count: number }[]>`
    SELECT count(*)::integer AS count FROM audit_events WHERE action = ${action}
  `;
  return rows[0]?.count ?? 0;
}

async function createGrantRequest(
  server: FastifyInstance,
  tokens: { readonly csrf: string; readonly session: string },
  idempotencyKey: string,
  payload: ReturnType<typeof grantPayload>,
) {
  return server.inject({
    headers: { ...writeHeaders(tokens), 'idempotency-key': idempotencyKey },
    method: 'POST',
    payload,
    url: API_PATH,
  });
}

async function createSession(
  database: Sql,
  userId: string,
): Promise<{ readonly csrf: string; readonly session: string }> {
  const session = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  await database`
    INSERT INTO sessions (user_id, active_tenant_id, session_hash, csrf_hash, expires_at)
    VALUES (${userId}, NULL, ${sha256(session)}, ${sha256(csrf)}, now() + interval '1 hour')
  `;
  return { csrf, session };
}

function writeHeaders(tokens: { readonly csrf: string; readonly session: string }) {
  return {
    cookie: `geo_session=${tokens.session}; geo_csrf=${tokens.csrf}`,
    'x-csrf-token': tokens.csrf,
  };
}

function requireServer(application: NestFastifyApplication | undefined): FastifyInstance {
  return requireApplication(application).getHttpAdapter().getInstance();
}

function requireApplication(
  application: NestFastifyApplication | undefined,
): NestFastifyApplication {
  if (!application) throw new Error('Support-access application was not initialized');
  return application;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Support-access PostgreSQL client was not initialized');
  return client;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
