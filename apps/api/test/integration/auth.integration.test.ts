import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApplication } from '../../src/application.js';
import { migrateDatabase } from '../../src/database/migrate.js';
import { PasswordHasher } from '../../src/modules/identity/auth/password-hasher.js';

const USER_ID = '10000000-0000-4000-8000-000000000014';
const EMAIL = 'active@example.com';
const PASSWORD = 'correct horse battery staple';
const API_AUTH_PATH = '/api/v1/auth';

describe('email/password auth', () => {
  let application: NestFastifyApplication | undefined;
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  let originalDatabaseUrl: string | undefined;
  let passwordHash = '';

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 2 });
    passwordHash = await new PasswordHasher().hash(PASSWORD);
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
    await database`TRUNCATE invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
    await database`
      INSERT INTO users (id, email, password_hash, display_name, status)
      VALUES (${USER_ID}, ${EMAIL}, ${passwordHash}, 'Active User', 'active')
    `;
  });

  afterAll(async () => {
    await application?.close();
    await client?.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = originalDatabaseUrl;
  });

  it('bootstraps CSRF and returns indistinguishable credential failures', async () => {
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const bootstrap = await server.inject({ method: 'GET', url: `${API_AUTH_PATH}/session` });
    const csrfToken = requireCookie(bootstrap.headers['set-cookie'], 'geo_csrf');

    expect(bootstrap.statusCode).toBe(401);
    expect(findSetCookie(bootstrap.headers['set-cookie'], 'geo_csrf')).toMatch(
      /Secure; SameSite=Lax/u,
    );
    expect(findSetCookie(bootstrap.headers['set-cookie'], 'geo_csrf')).not.toContain('HttpOnly');

    const headers = {
      cookie: `geo_csrf=${csrfToken}`,
      'x-csrf-token': csrfToken,
      'x-request-id': '00000000-0000-4000-8000-000000000014',
    };
    const wrongPassword = await server.inject({
      headers,
      method: 'POST',
      payload: { email: EMAIL, password: 'wrong', remember_me: false },
      url: `${API_AUTH_PATH}/login`,
    });
    const unknownEmail = await server.inject({
      headers,
      method: 'POST',
      payload: { email: 'unknown@example.com', password: 'wrong', remember_me: false },
      url: `${API_AUTH_PATH}/login`,
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(unknownEmail.json()).toEqual(wrongPassword.json());
    expect(JSON.stringify(wrongPassword.json())).not.toContain(EMAIL);
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();
  });

  it('creates hashed database sessions and hardened cookies, then resolves the session', async () => {
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const csrfToken = await bootstrapCsrf(server);
    const login = await loginRequest(server, csrfToken, false);

    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({
      data: {
        active_tenant_id: null,
        expires_at: expect.any(String),
        user: { display_name: 'Active User', email: EMAIL, id: USER_ID },
      },
      meta: { request_id: expect.any(String) },
    });
    expect(JSON.stringify(login.json())).not.toContain(passwordHash);

    const sessionCookie = findSetCookie(login.headers['set-cookie'], 'geo_session');
    const csrfCookie = findSetCookie(login.headers['set-cookie'], 'geo_csrf');
    expect(sessionCookie).toMatch(/HttpOnly; Secure; SameSite=Lax/u);
    expect(csrfCookie).toMatch(/Secure; SameSite=Lax/u);
    expect(csrfCookie).not.toContain('HttpOnly');

    const sessionToken = requireCookie(login.headers['set-cookie'], 'geo_session');
    const authenticatedCsrf = requireCookie(login.headers['set-cookie'], 'geo_csrf');
    const rows = await requireClient(client)<{ csrf_hash: string; session_hash: string }[]>`
      SELECT csrf_hash, session_hash FROM sessions
    `;
    expect(rows).toEqual([
      { csrf_hash: sha256(authenticatedCsrf), session_hash: sha256(sessionToken) },
    ]);
    expect(rows[0]?.session_hash).not.toContain(sessionToken);

    const session = await server.inject({
      headers: { cookie: `geo_session=${sessionToken}; geo_csrf=${authenticatedCsrf}` },
      method: 'GET',
      url: `${API_AUTH_PATH}/session`,
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().data.user.email).toBe(EMAIL);

    const recovered = await server.inject({
      headers: { cookie: `geo_session=${sessionToken}` },
      method: 'GET',
      url: `${API_AUTH_PATH}/session`,
    });
    const rotatedCsrf = requireCookie(recovered.headers['set-cookie'], 'geo_csrf');
    const rotatedRows = await requireClient(client)<{ csrf_hash: string }[]>`
      SELECT csrf_hash FROM sessions WHERE session_hash = ${sha256(sessionToken)}
    `;
    expect(recovered.statusCode).toBe(200);
    expect(rotatedCsrf).not.toBe(authenticatedCsrf);
    expect(rotatedRows).toEqual([{ csrf_hash: sha256(rotatedCsrf) }]);
  });

  it('requires double-submit CSRF, revokes logout atomically, and rejects replay', async () => {
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const csrfToken = await bootstrapCsrf(server);
    const login = await loginRequest(server, csrfToken, false);
    const sessionToken = requireCookie(login.headers['set-cookie'], 'geo_session');
    const authenticatedCsrf = requireCookie(login.headers['set-cookie'], 'geo_csrf');
    const cookie = `geo_session=${sessionToken}; geo_csrf=${authenticatedCsrf}`;

    const missingCsrf = await server.inject({
      headers: { cookie },
      method: 'POST',
      url: `${API_AUTH_PATH}/logout`,
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json().error.code).toBe('CSRF_INVALID');

    const logout = await server.inject({
      headers: { cookie, 'x-csrf-token': authenticatedCsrf },
      method: 'POST',
      url: `${API_AUTH_PATH}/logout`,
    });
    expect(logout.statusCode).toBe(204);
    expect(findSetCookie(logout.headers['set-cookie'], 'geo_session')).toContain('Max-Age=0');
    expect(findSetCookie(logout.headers['set-cookie'], 'geo_csrf')).toContain('Max-Age=0');

    const rows = await requireClient(client)<{ revoked: boolean }[]>`
      SELECT revoked_at IS NOT NULL AS revoked FROM sessions
    `;
    expect(rows).toEqual([{ revoked: true }]);

    const replay = await server.inject({
      headers: { cookie },
      method: 'GET',
      url: `${API_AUTH_PATH}/session`,
    });
    expect(replay.statusCode).toBe(401);
  });

  it('invalidates active sessions immediately when the user is disabled or the session expires', async () => {
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const firstCsrf = await bootstrapCsrf(server);
    const firstLogin = await loginRequest(server, firstCsrf, false);
    const firstSessionToken = requireCookie(firstLogin.headers['set-cookie'], 'geo_session');
    const firstAuthenticatedCsrf = requireCookie(firstLogin.headers['set-cookie'], 'geo_csrf');

    await requireClient(client)`UPDATE users SET status = 'disabled' WHERE id = ${USER_ID}`;
    const disabled = await server.inject({
      headers: {
        cookie: `geo_session=${firstSessionToken}; geo_csrf=${firstAuthenticatedCsrf}`,
      },
      method: 'GET',
      url: `${API_AUTH_PATH}/session`,
    });
    expect(disabled.statusCode).toBe(401);

    await requireClient(client)`UPDATE users SET status = 'active' WHERE id = ${USER_ID}`;
    const secondCsrf = await bootstrapCsrf(server);
    const secondLogin = await loginRequest(server, secondCsrf, false);
    const secondSessionToken = requireCookie(secondLogin.headers['set-cookie'], 'geo_session');
    const secondAuthenticatedCsrf = requireCookie(secondLogin.headers['set-cookie'], 'geo_csrf');
    await requireClient(client)`
      UPDATE sessions
      SET
        created_at = now() - interval '2 hours',
        expires_at = now() - interval '1 second'
      WHERE session_hash = ${sha256(secondSessionToken)}
    `;
    const expired = await server.inject({
      headers: {
        cookie: `geo_session=${secondSessionToken}; geo_csrf=${secondAuthenticatedCsrf}`,
      },
      method: 'GET',
      url: `${API_AUTH_PATH}/session`,
    });
    expect(expired.statusCode).toBe(401);
  });

  it('applies the remembered session lifetime and never echoes invalid secrets', async () => {
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const csrfToken = await bootstrapCsrf(server);
    const login = await loginRequest(server, csrfToken, true);
    const sessionCookie = findSetCookie(login.headers['set-cookie'], 'geo_session');
    const stored = await requireClient(client)<{ lifetime_seconds: number }[]>`
      SELECT extract(epoch FROM (expires_at - created_at))::integer AS lifetime_seconds
      FROM sessions
    `;

    expect(sessionCookie).toContain('Max-Age=2592000');
    expect(stored[0]?.lifetime_seconds).toBeGreaterThanOrEqual(2_591_999);

    const invalid = await server.inject({
      headers: { cookie: `geo_csrf=${csrfToken}`, 'x-csrf-token': csrfToken },
      method: 'POST',
      payload: { email: EMAIL, extra: PASSWORD, password: PASSWORD },
      url: `${API_AUTH_PATH}/login`,
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.code).toBe('SCHEMA_VALIDATION_FAILED');
    expect(JSON.stringify(invalid.json())).not.toContain(PASSWORD);
  });
});

async function bootstrapCsrf(server: FastifyInstance): Promise<string> {
  const response = await server.inject({ method: 'GET', url: `${API_AUTH_PATH}/session` });
  expect(response.statusCode).toBe(401);
  return requireCookie(response.headers['set-cookie'], 'geo_csrf');
}

async function loginRequest(server: FastifyInstance, csrfToken: string, rememberMe: boolean) {
  return server.inject({
    headers: { cookie: `geo_csrf=${csrfToken}`, 'x-csrf-token': csrfToken },
    method: 'POST',
    payload: { email: EMAIL.toUpperCase(), password: PASSWORD, remember_me: rememberMe },
    url: `${API_AUTH_PATH}/login`,
  });
}

function findSetCookie(header: string | string[] | undefined, name: string): string {
  const values = Array.isArray(header) ? header : header ? [header] : [];
  return values.find((value) => value.startsWith(`${name}=`)) ?? '';
}

function requireCookie(header: string | string[] | undefined, name: string): string {
  const cookie = findSetCookie(header, name);
  const value = cookie.slice(name.length + 1).split(';', 1)[0];
  if (!value) throw new Error(`Expected ${name} Set-Cookie header`);
  return value;
}

function requireApplication(
  application: NestFastifyApplication | undefined,
): NestFastifyApplication {
  if (!application) throw new Error('Auth test application was not initialized');
  return application;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Auth test PostgreSQL client was not initialized');
  return client;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
