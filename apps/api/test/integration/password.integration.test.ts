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
import { IdentityAuthDatabase } from '../../src/modules/identity/auth/auth.database.js';
import { PasswordHasher } from '../../src/modules/identity/auth/password-hasher.js';
import {
  PasswordResetDelivery,
  type PasswordResetDeliveryMessage,
} from '../../src/modules/identity/password/password-reset.delivery.js';
import { PasswordService } from '../../src/modules/identity/password/password.service.js';

const USER_ID = '10000000-0000-4000-8000-000000000015';
const EMAIL = 'password@example.com';
const OLD_PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a much better enterprise passphrase';
const API_AUTH_PATH = '/api/v1/auth';

class CapturingPasswordResetDelivery extends PasswordResetDelivery {
  public readonly messages: PasswordResetDeliveryMessage[] = [];

  public deliver(message: PasswordResetDeliveryMessage): Promise<void> {
    this.messages.push(message);
    return Promise.resolve();
  }
}

describe('password flows', () => {
  let application: NestFastifyApplication | undefined;
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  let originalDatabaseUrl: string | undefined;
  let oldPasswordHash = '';

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 2 });
    oldPasswordHash = await new PasswordHasher().hash(OLD_PASSWORD);
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
    await database`TRUNCATE password_reset_tokens, sessions, platform_roles, memberships, tenants, users CASCADE`;
    await database`
      INSERT INTO users (id, email, password_hash, display_name, status)
      VALUES (${USER_ID}, ${EMAIL}, ${oldPasswordHash}, 'Password User', 'active')
    `;
  });

  afterAll(async () => {
    await application?.close();
    await client?.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = originalDatabaseUrl;
  });

  it('enforces immutable one-time token history at the database boundary', async () => {
    const database = requireClient(client);
    const tokenHash = sha256('a'.repeat(43));
    const [resetToken] = await database<{ id: string }[]>`
      INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
      VALUES (${USER_ID}, ${tokenHash}, now() + interval '1 hour')
      RETURNING id
    `;
    if (!resetToken) throw new Error('Expected reset token fixture');

    await expect(
      database`UPDATE password_reset_tokens SET token_hash = ${'b'.repeat(64)} WHERE id = ${resetToken.id}`,
    ).rejects.toThrow(/identity is immutable/u);
    await expect(
      database`DELETE FROM password_reset_tokens WHERE id = ${resetToken.id}`,
    ).rejects.toThrow(/append-only/u);
    await database`UPDATE password_reset_tokens SET used_at = now() WHERE id = ${resetToken.id}`;
    await expect(
      database`UPDATE password_reset_tokens SET used_at = now() WHERE id = ${resetToken.id}`,
    ).rejects.toThrow(/unused to used/u);
  });

  it('returns generic 202 responses and stores only the reset-token digest', async () => {
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const csrfToken = await bootstrapCsrf(server);
    const headers = { cookie: `geo_csrf=${csrfToken}`, 'x-csrf-token': csrfToken };
    const existing = await server.inject({
      headers,
      method: 'POST',
      payload: { email: EMAIL.toUpperCase() },
      url: `${API_AUTH_PATH}/password/forgot`,
    });
    const unknown = await server.inject({
      headers,
      method: 'POST',
      payload: { email: 'unknown@example.com' },
      url: `${API_AUTH_PATH}/password/forgot`,
    });
    const rows = await requireClient(client)<{ token_hash: string }[]>`
      SELECT token_hash FROM password_reset_tokens
    `;

    expect(existing.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(existing.body).toBe('');
    expect(unknown.body).toBe('');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(rows)).not.toContain(EMAIL);
  });

  it('serializes concurrent reset requests so only the latest token remains usable', async () => {
    const app = requireApplication(application);
    const delivery = new CapturingPasswordResetDelivery();
    const passwordService = new PasswordService(
      app.get(IdentityAuthDatabase),
      app.get(PasswordHasher),
      delivery,
    );

    await Promise.all([passwordService.requestReset(EMAIL), passwordService.requestReset(EMAIL)]);
    const rows = await requireClient(client)<{ token_hash: string; used: boolean }[]>`
      SELECT token_hash, used_at IS NOT NULL AS used
      FROM password_reset_tokens
      ORDER BY created_at, id
    `;
    const deliveredHashes = delivery.messages.map(({ token }) => sha256(token));

    expect(delivery.messages).toHaveLength(2);
    expect(rows).toHaveLength(2);
    expect(rows.filter(({ used }) => used)).toHaveLength(1);
    expect(rows.filter(({ used }) => !used)).toHaveLength(1);
    expect(deliveredHashes).toContain(rows.find(({ used }) => !used)?.token_hash);
  });

  it('consumes a delivered reset token once and revokes every active session', async () => {
    const app = requireApplication(application);
    const server = app.getHttpAdapter().getInstance();
    const firstLogin = await login(server, OLD_PASSWORD);
    const secondLogin = await login(server, OLD_PASSWORD);
    expect(firstLogin.statusCode).toBe(200);
    expect(secondLogin.statusCode).toBe(200);

    const delivery = new CapturingPasswordResetDelivery();
    const passwordService = new PasswordService(
      app.get(IdentityAuthDatabase),
      app.get(PasswordHasher),
      delivery,
    );
    await passwordService.requestReset(EMAIL);
    const message = delivery.messages[0];
    if (!message) throw new Error('Expected captured password reset delivery');
    const stored = await requireClient(client)<{ token_hash: string }[]>`
      SELECT token_hash FROM password_reset_tokens WHERE id = ${message.resetTokenId}
    `;
    expect(stored).toEqual([{ token_hash: sha256(message.token) }]);

    const csrfToken = await bootstrapCsrf(server);
    const reset = await server.inject({
      headers: { cookie: `geo_csrf=${csrfToken}`, 'x-csrf-token': csrfToken },
      method: 'POST',
      payload: { new_password: NEW_PASSWORD, token: message.token },
      url: `${API_AUTH_PATH}/password/reset`,
    });
    expect(reset.statusCode).toBe(204);

    const state = await requireClient(client)<
      {
        password_changed: boolean;
        password_hash: string;
        revoked_sessions: number;
        used_tokens: number;
      }[]
    >`
      SELECT
        identity_user.password_hash,
        identity_user.password_changed_at IS NOT NULL AS password_changed,
        (SELECT count(*)::integer FROM sessions WHERE revoked_at IS NOT NULL) AS revoked_sessions,
        (SELECT count(*)::integer FROM password_reset_tokens WHERE used_at IS NOT NULL) AS used_tokens
      FROM users AS identity_user
      WHERE identity_user.id = ${USER_ID}
    `;
    expect(state[0]).toMatchObject({ password_changed: true, revoked_sessions: 2, used_tokens: 1 });
    await expect(new PasswordHasher().verify(state[0]?.password_hash, NEW_PASSWORD)).resolves.toBe(
      true,
    );

    const replayCsrf = await bootstrapCsrf(server);
    const replay = await server.inject({
      headers: { cookie: `geo_csrf=${replayCsrf}`, 'x-csrf-token': replayCsrf },
      method: 'POST',
      payload: { new_password: 'another secure enterprise passphrase', token: message.token },
      url: `${API_AUTH_PATH}/password/reset`,
    });
    expect(replay.statusCode).toBe(404);
    expect(replay.json().error.code).toBe('RESOURCE_NOT_FOUND');
    expect((await login(server, OLD_PASSWORD)).statusCode).toBe(401);
    expect((await login(server, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('changes an authenticated password and revokes all sessions and pending reset tokens', async () => {
    const app = requireApplication(application);
    const server = app.getHttpAdapter().getInstance();
    const firstLogin = await login(server, OLD_PASSWORD);
    await login(server, OLD_PASSWORD);
    const sessionToken = requireCookie(firstLogin.headers['set-cookie'], 'geo_session');
    const csrfToken = requireCookie(firstLogin.headers['set-cookie'], 'geo_csrf');
    await requireClient(client)`
      INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
      VALUES (${USER_ID}, ${'c'.repeat(64)}, now() + interval '1 hour')
    `;

    const wrong = await server.inject({
      headers: {
        cookie: `geo_session=${sessionToken}; geo_csrf=${csrfToken}`,
        'x-csrf-token': csrfToken,
      },
      method: 'POST',
      payload: { current_password: 'wrong password', new_password: NEW_PASSWORD },
      url: `${API_AUTH_PATH}/password/change`,
    });
    expect(wrong.statusCode).toBe(401);

    const changed = await server.inject({
      headers: {
        cookie: `geo_session=${sessionToken}; geo_csrf=${csrfToken}`,
        'x-csrf-token': csrfToken,
      },
      method: 'POST',
      payload: { current_password: OLD_PASSWORD, new_password: NEW_PASSWORD },
      url: `${API_AUTH_PATH}/password/change`,
    });
    expect(changed.statusCode).toBe(204);
    expect(findSetCookie(changed.headers['set-cookie'], 'geo_session')).toContain('Max-Age=0');

    const state = await requireClient(client)<{ revoked: number; used: number }[]>`
      SELECT
        (SELECT count(*)::integer FROM sessions WHERE revoked_at IS NOT NULL) AS revoked,
        (SELECT count(*)::integer FROM password_reset_tokens WHERE used_at IS NOT NULL) AS used
    `;
    expect(state).toEqual([{ revoked: 2, used: 1 }]);
    expect((await login(server, OLD_PASSWORD)).statusCode).toBe(401);
    expect((await login(server, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('rejects expired tokens and never echoes password values in schema errors', async () => {
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const token = 'e'.repeat(43);
    await requireClient(client)`
      INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at)
      VALUES (
        ${USER_ID},
        ${sha256(token)},
        now() - interval '1 hour',
        now() - interval '2 hours'
      )
    `;
    const csrfToken = await bootstrapCsrf(server);
    const headers = { cookie: `geo_csrf=${csrfToken}`, 'x-csrf-token': csrfToken };
    const expired = await server.inject({
      headers,
      method: 'POST',
      payload: { new_password: NEW_PASSWORD, token },
      url: `${API_AUTH_PATH}/password/reset`,
    });
    const secret = 'too-short';
    const invalid = await server.inject({
      headers,
      method: 'POST',
      payload: { new_password: secret, token },
      url: `${API_AUTH_PATH}/password/reset`,
    });

    expect(expired.statusCode).toBe(404);
    expect(invalid.statusCode).toBe(422);
    expect(JSON.stringify(invalid.json())).not.toContain(secret);
  });
});

async function bootstrapCsrf(server: FastifyInstance): Promise<string> {
  const response = await server.inject({ method: 'GET', url: `${API_AUTH_PATH}/session` });
  expect(response.statusCode).toBe(401);
  return requireCookie(response.headers['set-cookie'], 'geo_csrf');
}

async function login(server: FastifyInstance, password: string) {
  const csrfToken = await bootstrapCsrf(server);
  return server.inject({
    headers: { cookie: `geo_csrf=${csrfToken}`, 'x-csrf-token': csrfToken },
    method: 'POST',
    payload: { email: EMAIL, password, remember_me: false },
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
  if (!application) throw new Error('Password test application was not initialized');
  return application;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Password test PostgreSQL client was not initialized');
  return client;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
