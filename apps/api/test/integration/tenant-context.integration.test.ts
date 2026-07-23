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
import { PasswordHasher } from '../../src/modules/identity/auth/password-hasher.js';

const USER_ID = '10000000-0000-4000-8000-000000000017';
const TENANT_A_ID = '20000000-0000-4000-8000-000000000017';
const TENANT_B_ID = '20000000-0000-4000-8000-000000000117';
const DISABLED_TENANT_ID = '20000000-0000-4000-8000-000000000217';
const SUSPENDED_TENANT_ID = '20000000-0000-4000-8000-000000000317';
const API_AUTH_PATH = '/api/v1/auth';

describe('tenant context', () => {
  let application: NestFastifyApplication | undefined;
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  let originalDatabaseUrl: string | undefined;
  let passwordHash = '';

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 4 });
    passwordHash = await new PasswordHasher().hash('correct horse battery staple');
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
    await database`TRUNCATE idempotency_records, password_reset_tokens, invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
    await database`
      INSERT INTO users (id, email, password_hash, display_name, status)
      VALUES (${USER_ID}, 'tenant-user@example.com', ${passwordHash}, 'Tenant User', 'active')
    `;
    await database`
      INSERT INTO tenants (id, name, slug, status)
      VALUES
        (${TENANT_A_ID}, 'Alpha Tenant', 'alpha-tenant', 'active'),
        (${TENANT_B_ID}, 'Beta Tenant', 'beta-tenant', 'active'),
        (${DISABLED_TENANT_ID}, 'Disabled Membership', 'disabled-membership', 'active'),
        (${SUSPENDED_TENANT_ID}, 'Suspended Tenant', 'suspended-tenant', 'suspended')
    `;
    await database`
      INSERT INTO memberships (tenant_id, user_id, role_code, status)
      VALUES
        (${TENANT_A_ID}, ${USER_ID}, 'tenant_admin', 'active'),
        (${TENANT_B_ID}, ${USER_ID}, 'reviewer', 'active'),
        (${DISABLED_TENANT_ID}, ${USER_ID}, 'viewer', 'disabled'),
        (${SUSPENDED_TENANT_ID}, ${USER_ID}, 'tenant_owner', 'active')
    `;
  });

  afterAll(async () => {
    await application?.close();
    await client?.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = originalDatabaseUrl;
  });

  it('lists only currently active memberships and reports role, last use, and current choice', async () => {
    const database = requireClient(client);
    await createSession(database, USER_ID, TENANT_A_ID, new Date(Date.now() - 60_000));
    const current = await createSession(database, USER_ID, TENANT_B_ID);
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const response = await server.inject({
      headers: { cookie: `geo_session=${current.session}; geo_csrf=${current.csrf}` },
      method: 'GET',
      url: `${API_AUTH_PATH}/tenants`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      {
        id: TENANT_B_ID,
        is_active: true,
        last_used_at: expect.any(String),
        name: 'Beta Tenant',
        role_code: 'reviewer',
        slug: 'beta-tenant',
      },
      {
        id: TENANT_A_ID,
        is_active: false,
        last_used_at: expect.any(String),
        name: 'Alpha Tenant',
        role_code: 'tenant_admin',
        slug: 'alpha-tenant',
      },
    ]);
    expect(JSON.stringify(response.json())).not.toContain(DISABLED_TENANT_ID);
    expect(JSON.stringify(response.json())).not.toContain(SUSPENDED_TENANT_ID);
  });

  it('requires a strict DTO and Idempotency-Key, then persists and replays the selected tenant', async () => {
    const database = requireClient(client);
    const tokens = await createSession(database, USER_ID, null);
    const server = requireApplication(application).getHttpAdapter().getInstance();

    const missingKey = await server.inject({
      headers: writeHeaders(tokens),
      method: 'POST',
      payload: { tenant_id: TENANT_A_ID },
      url: `${API_AUTH_PATH}/switch-tenant`,
    });
    expect(missingKey.statusCode).toBe(422);
    expect(missingKey.json().error.code).toBe('SCHEMA_VALIDATION_FAILED');

    const unavailable = await server.inject({
      headers: { ...writeHeaders(tokens), 'idempotency-key': 'unavailable-tenant' },
      method: 'POST',
      payload: { tenant_id: DISABLED_TENANT_ID },
      url: `${API_AUTH_PATH}/switch-tenant`,
    });
    expect(unavailable.statusCode).toBe(404);
    expect(unavailable.json().error.code).toBe('RESOURCE_NOT_FOUND');

    const request = {
      headers: { ...writeHeaders(tokens), 'idempotency-key': 'select-alpha' },
      method: 'POST' as const,
      payload: { tenant_id: TENANT_A_ID },
      url: `${API_AUTH_PATH}/switch-tenant`,
    };
    const switched = await server.inject(request);
    const replay = await server.inject(request);
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toMatchObject({
      data: {
        active_tenant_id: TENANT_A_ID,
        user: { email: 'tenant-user@example.com', id: USER_ID },
      },
    });
    expect(replay.json()).toEqual(switched.json());

    const state = await database<{ active_tenant_id: string; idempotency_records: number }[]>`
      SELECT
        session.active_tenant_id,
        (SELECT count(*)::integer FROM idempotency_records) AS idempotency_records
      FROM sessions AS session
      WHERE session.session_hash = ${sha256(tokens.session)}
    `;
    expect(state).toEqual([{ active_tenant_id: TENANT_A_ID, idempotency_records: 1 }]);

    const secretExtra = 'must-not-echo';
    const invalid = await server.inject({
      headers: { ...writeHeaders(tokens), 'idempotency-key': 'invalid-body' },
      method: 'POST',
      payload: { extra: secretExtra, tenant_id: TENANT_B_ID },
      url: `${API_AUTH_PATH}/switch-tenant`,
    });
    expect(invalid.statusCode).toBe(422);
    expect(JSON.stringify(invalid.json())).not.toContain(secretExtra);
  });

  it('rechecks membership on every request and permits recovery by switching another tenant', async () => {
    const database = requireClient(client);
    const tokens = await createSession(database, USER_ID, TENANT_A_ID);
    const server = requireApplication(application).getHttpAdapter().getInstance();
    await database`
      UPDATE memberships SET status = 'disabled'
      WHERE tenant_id = ${TENANT_A_ID} AND user_id = ${USER_ID}
    `;

    const strictSession = await server.inject({
      headers: { cookie: `geo_session=${tokens.session}; geo_csrf=${tokens.csrf}` },
      method: 'GET',
      url: `${API_AUTH_PATH}/session`,
    });
    expect(strictSession.statusCode).toBe(401);

    const choices = await server.inject({
      headers: { cookie: `geo_session=${tokens.session}; geo_csrf=${tokens.csrf}` },
      method: 'GET',
      url: `${API_AUTH_PATH}/tenants`,
    });
    expect(choices.statusCode).toBe(200);
    expect(choices.json().data).toEqual([
      expect.objectContaining({ id: TENANT_B_ID, is_active: false, role_code: 'reviewer' }),
    ]);

    const recovered = await server.inject({
      headers: { ...writeHeaders(tokens), 'idempotency-key': 'recover-beta' },
      method: 'POST',
      payload: { tenant_id: TENANT_B_ID },
      url: `${API_AUTH_PATH}/switch-tenant`,
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().data.active_tenant_id).toBe(TENANT_B_ID);

    const recoveredSession = await server.inject({
      headers: { cookie: `geo_session=${tokens.session}; geo_csrf=${tokens.csrf}` },
      method: 'GET',
      url: `${API_AUTH_PATH}/session`,
    });
    expect(recoveredSession.statusCode).toBe(200);
    expect(recoveredSession.json().data.active_tenant_id).toBe(TENANT_B_ID);
  });

  it('rejects expired, revoked, or disabled-user identity sessions', async () => {
    const database = requireClient(client);
    const expired = await createSession(database, USER_ID, null);
    await database`
      UPDATE sessions
      SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 second'
      WHERE session_hash = ${sha256(expired.session)}
    `;
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const expiredResponse = await server.inject({
      headers: { cookie: `geo_session=${expired.session}` },
      method: 'GET',
      url: `${API_AUTH_PATH}/tenants`,
    });
    expect(expiredResponse.statusCode).toBe(401);

    const revoked = await createSession(database, USER_ID, null);
    await database`
      UPDATE sessions SET revoked_at = now() WHERE session_hash = ${sha256(revoked.session)}
    `;
    const revokedResponse = await server.inject({
      headers: { cookie: `geo_session=${revoked.session}` },
      method: 'GET',
      url: `${API_AUTH_PATH}/tenants`,
    });
    expect(revokedResponse.statusCode).toBe(401);

    const disabled = await createSession(database, USER_ID, null);
    await database`UPDATE users SET status = 'disabled' WHERE id = ${USER_ID}`;
    const disabledResponse = await server.inject({
      headers: { cookie: `geo_session=${disabled.session}` },
      method: 'GET',
      url: `${API_AUTH_PATH}/tenants`,
    });
    expect(disabledResponse.statusCode).toBe(401);
  });
});

async function createSession(
  database: Sql,
  userId: string,
  tenantId: string | null,
  lastSeenAt = new Date(),
): Promise<{ readonly csrf: string; readonly session: string }> {
  const session = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  await database`
    INSERT INTO sessions (
      user_id, active_tenant_id, session_hash, csrf_hash, expires_at, last_seen_at
    ) VALUES (
      ${userId}, ${tenantId}, ${sha256(session)}, ${sha256(csrf)},
      now() + interval '1 hour', ${lastSeenAt.toISOString()}
    )
  `;
  return { csrf, session };
}

function writeHeaders(tokens: { readonly csrf: string; readonly session: string }) {
  return {
    cookie: `geo_session=${tokens.session}; geo_csrf=${tokens.csrf}`,
    'x-csrf-token': tokens.csrf,
  };
}

function requireApplication(
  application: NestFastifyApplication | undefined,
): NestFastifyApplication {
  if (!application) throw new Error('Tenant-context test application was not initialized');
  return application;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Tenant-context PostgreSQL client was not initialized');
  return client;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
