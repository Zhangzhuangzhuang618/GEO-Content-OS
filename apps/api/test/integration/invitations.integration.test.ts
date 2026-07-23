import type { EmailAdapter, InvitationEmail } from '@geo-content-os/adapter-email';
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
import { AuthService } from '../../src/modules/identity/auth/auth.service.js';
import { IdentityAuthDatabase } from '../../src/modules/identity/auth/auth.database.js';
import { PasswordHasher } from '../../src/modules/identity/auth/password-hasher.js';
import { InvitationService } from '../../src/modules/identity/invitations/invitation.service.js';

const OWNER_ID = '10000000-0000-4000-8000-000000000016';
const ADMIN_ID = '10000000-0000-4000-8000-000000000216';
const EDITOR_ID = '10000000-0000-4000-8000-000000000116';
const TENANT_ID = '20000000-0000-4000-8000-000000000016';
const OTHER_TENANT_ID = '20000000-0000-4000-8000-000000000116';
const WORKSPACE_ID = '30000000-0000-4000-8000-000000000016';
const OTHER_WORKSPACE_ID = '30000000-0000-4000-8000-000000000116';
const OWNER_PASSWORD = 'correct horse battery staple';
const INVITEE_PASSWORD = 'an enterprise invitation passphrase';
const API_INVITATIONS_PATH = '/api/v1/invitations';
const API_AUTH_PATH = '/api/v1/auth';

class CapturingEmailAdapter implements EmailAdapter {
  public readonly invitations: InvitationEmail[] = [];

  public sendInvitation(message: InvitationEmail) {
    this.invitations.push(message);
    return Promise.resolve({
      messageId: `invitation-${this.invitations.length}`,
      transport: 'smtp' as const,
    });
  }

  public sendPasswordReset() {
    return Promise.resolve({ messageId: 'unused', transport: 'smtp' as const });
  }
}

describe('invitations', () => {
  let application: NestFastifyApplication | undefined;
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  let originalDatabaseUrl: string | undefined;
  let ownerPasswordHash = '';

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 4 });
    ownerPasswordHash = await new PasswordHasher().hash(OWNER_PASSWORD);
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
    await database`TRUNCATE password_reset_tokens, invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
    await database`
      INSERT INTO users (id, email, password_hash, display_name, status)
      VALUES
        (${OWNER_ID}, 'owner@example.com', ${ownerPasswordHash}, 'Tenant Owner', 'active'),
        (${ADMIN_ID}, 'admin@example.com', ${ownerPasswordHash}, 'Tenant Admin', 'active'),
        (${EDITOR_ID}, 'editor@example.com', ${ownerPasswordHash}, 'Content Editor', 'active')
    `;
    await database`
      INSERT INTO tenants (id, name, slug, status)
      VALUES
        (${TENANT_ID}, 'Acme GEO', 'acme-geo', 'active'),
        (${OTHER_TENANT_ID}, 'Other GEO', 'other-geo', 'active')
    `;
    await database`
      INSERT INTO memberships (tenant_id, user_id, role_code, status)
      VALUES
        (${TENANT_ID}, ${OWNER_ID}, 'tenant_owner', 'active'),
        (${TENANT_ID}, ${ADMIN_ID}, 'tenant_admin', 'active'),
        (${TENANT_ID}, ${EDITOR_ID}, 'content_editor', 'active'),
        (${OTHER_TENANT_ID}, ${OWNER_ID}, 'tenant_owner', 'active')
    `;
    await database`
      INSERT INTO workspaces (id, tenant_id, name, slug, timezone)
      VALUES
        (${WORKSPACE_ID}, ${TENANT_ID}, 'Invitation Workspace', 'invitation-workspace', 'UTC'),
        (${OTHER_WORKSPACE_ID}, ${OTHER_TENANT_ID}, 'Other Invitation Workspace', 'other-invitation-workspace', 'UTC')
    `;
  });

  afterAll(async () => {
    await application?.close();
    await client?.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = originalDatabaseUrl;
  });

  it('enforces pending uniqueness and immutable append-only invitation history', async () => {
    const database = requireClient(client);
    const [invitation] = await database<{ id: string }[]>`
      INSERT INTO invitations (
        tenant_id, email, role_code, token_hash, expires_at, invited_by
      ) VALUES (
        ${TENANT_ID}, 'history@example.com', 'viewer', ${sha256('h'.repeat(43))},
        now() + interval '72 hours', ${OWNER_ID}
      )
      RETURNING id
    `;
    if (!invitation) throw new Error('Expected invitation history fixture');

    await expect(
      database`
        INSERT INTO invitations (
          tenant_id, email, role_code, token_hash, expires_at, invited_by
        ) VALUES (
          ${TENANT_ID}, 'history@example.com', 'viewer', ${sha256('i'.repeat(43))},
          now() + interval '72 hours', ${OWNER_ID}
        )
      `,
    ).rejects.toThrow(/invitations_tenant_email_pending_uq/u);
    await expect(
      database`UPDATE invitations SET role_code = 'analyst' WHERE id = ${invitation.id}`,
    ).rejects.toThrow(/identity and scope are immutable/u);
    await expect(database`DELETE FROM invitations WHERE id = ${invitation.id}`).rejects.toThrow(
      /append-only/u,
    );
    await database`UPDATE invitations SET revoked_at = now() WHERE id = ${invitation.id}`;
    await expect(
      database`UPDATE invitations SET revoked_at = now() WHERE id = ${invitation.id}`,
    ).rejects.toThrow(/terminal invitation cannot change/u);
  });

  it('creates a 72-hour tenant-scoped invitation idempotently and enforces owner/admin access', async () => {
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const owner = await createSession(requireClient(client), OWNER_ID, TENANT_ID);
    const payload = {
      email: 'new-user@example.com',
      role_code: 'content_editor',
      workspace_scope: {},
    };
    const first = await server.inject({
      headers: { ...writeHeaders(owner), 'idempotency-key': 'create-new-user' },
      method: 'POST',
      payload,
      url: API_INVITATIONS_PATH,
    });
    const duplicate = await server.inject({
      headers: { ...writeHeaders(owner), 'idempotency-key': 'create-new-user' },
      method: 'POST',
      payload,
      url: API_INVITATIONS_PATH,
    });

    expect(first.statusCode).toBe(201);
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json().data.id).toBe(first.json().data.id);
    const rows = await requireClient(client)<{ lifetime_hours: number; token_hash: string }[]>`
      SELECT
        extract(epoch FROM (expires_at - created_at))::integer / 3600 AS lifetime_hours,
        token_hash
      FROM invitations
      WHERE tenant_id = ${TENANT_ID} AND email = ${payload.email}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      lifetime_hours: 72,
      token_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(JSON.stringify(first.json())).not.toContain(rows[0]?.token_hash);

    const changed = await server.inject({
      headers: { ...writeHeaders(owner), 'idempotency-key': 'create-new-user' },
      method: 'POST',
      payload: { ...payload, role_code: 'reviewer' },
      url: API_INVITATIONS_PATH,
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe('IDEMPOTENCY_CONFLICT');

    const editor = await createSession(requireClient(client), EDITOR_ID, TENANT_ID);
    const forbidden = await server.inject({
      headers: { ...writeHeaders(editor), 'idempotency-key': 'forbidden-invite' },
      method: 'POST',
      payload: { ...payload, email: 'forbidden@example.com' },
      url: API_INVITATIONS_PATH,
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('PERMISSION_DENIED');

    const missingKey = await server.inject({
      headers: writeHeaders(owner),
      method: 'POST',
      payload: { ...payload, email: 'missing-key@example.com' },
      url: API_INVITATIONS_PATH,
    });
    expect(missingKey.statusCode).toBe(422);
    expect(missingKey.json().error.code).toBe('SCHEMA_VALIDATION_FAILED');

    const admin = await createSession(requireClient(client), ADMIN_ID, TENANT_ID);
    const ownerEscalation = await server.inject({
      headers: { ...writeHeaders(admin), 'idempotency-key': 'admin-owner-escalation' },
      method: 'POST',
      payload: { ...payload, email: 'owner-escalation@example.com', role_code: 'tenant_owner' },
      url: API_INVITATIONS_PATH,
    });
    expect(ownerEscalation.statusCode).toBe(403);
    expect(ownerEscalation.json().error.code).toBe('PERMISSION_DENIED');
  });

  it('serializes duplicate creation, delivers one raw token, and accepts it exactly once', async () => {
    const app = requireApplication(application);
    const delivery = new CapturingEmailAdapter();
    const service = createInvitationService(app, delivery);
    const input = {
      actorUserId: OWNER_ID,
      request: {
        email: 'accepted@example.com',
        role_code: 'reviewer' as const,
        workspace_scope: { workspace_ids: [WORKSPACE_ID] },
      },
      tenantId: TENANT_ID,
    };
    const [first, duplicate] = await Promise.all([service.create(input), service.create(input)]);

    expect(first.id).toBe(duplicate.id);
    expect(delivery.invitations).toHaveLength(1);
    const message = delivery.invitations[0];
    if (!message) throw new Error('Expected captured invitation');
    const stored = await requireClient(client)<{ token_hash: string }[]>`
      SELECT token_hash FROM invitations WHERE id = ${first.id}
    `;
    expect(stored).toEqual([{ token_hash: sha256(message.token) }]);

    const server = app.getHttpAdapter().getInstance();
    const csrf = await bootstrapCsrf(server);
    const accepted = await server.inject({
      headers: { cookie: `geo_csrf=${csrf}`, 'x-csrf-token': csrf },
      method: 'POST',
      payload: { display_name: 'Accepted User', password: INVITEE_PASSWORD },
      url: `${API_INVITATIONS_PATH}/${message.token}/accept`,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      data: {
        active_tenant_id: TENANT_ID,
        user: { display_name: 'Accepted User', email: input.request.email },
      },
    });
    expect(findSetCookie(accepted.headers['set-cookie'], 'geo_session')).toMatch(
      /HttpOnly; Secure; SameSite=Lax/u,
    );
    const state = await requireClient(client)<{ accepted: boolean; membership_status: string }[]>`
      SELECT
        invitation.accepted_at IS NOT NULL AS accepted,
        membership.status AS membership_status
      FROM invitations AS invitation
      JOIN users AS identity_user ON identity_user.email = invitation.email
      JOIN memberships AS membership
        ON membership.tenant_id = invitation.tenant_id AND membership.user_id = identity_user.id
      WHERE invitation.id = ${first.id}
    `;
    expect(state).toEqual([{ accepted: true, membership_status: 'active' }]);
    expect(
      await requireClient(client)<{ workspace_id: string }[]>`
        SELECT workspace_id FROM workspace_memberships
        WHERE user_id = (SELECT id FROM users WHERE email = ${input.request.email})
      `,
    ).toEqual([{ workspace_id: WORKSPACE_ID }]);

    const replayCsrf = await bootstrapCsrf(server);
    const replay = await server.inject({
      headers: { cookie: `geo_csrf=${replayCsrf}`, 'x-csrf-token': replayCsrf },
      method: 'POST',
      payload: { display_name: 'Accepted User', password: INVITEE_PASSWORD },
      url: `${API_INVITATIONS_PATH}/${message.token}/accept`,
    });
    expect(replay.statusCode).toBe(404);
    expect(replay.json().error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('rejects invitation workspace scope outside the active tenant', async () => {
    const service = createInvitationService(
      requireApplication(application),
      new CapturingEmailAdapter(),
    );
    await expect(
      service.create({
        actorUserId: OWNER_ID,
        request: {
          email: 'forged-scope@example.com',
          role_code: 'viewer',
          workspace_scope: { workspace_ids: [OTHER_WORKSPACE_ID] },
        },
        tenantId: TENANT_ID,
      }),
    ).rejects.toThrow(/Invitation/u);
  });

  it('revokes only within the active tenant and does not leak invalid token or password values', async () => {
    const app = requireApplication(application);
    const delivery = new CapturingEmailAdapter();
    const invitation = await createInvitationService(app, delivery).create({
      actorUserId: OWNER_ID,
      request: { email: 'revoked@example.com', role_code: 'viewer', workspace_scope: {} },
      tenantId: TENANT_ID,
    });
    const server = app.getHttpAdapter().getInstance();
    const wrongTenant = await createSession(requireClient(client), OWNER_ID, OTHER_TENANT_ID);
    const hidden = await server.inject({
      headers: writeHeaders(wrongTenant),
      method: 'DELETE',
      url: `${API_INVITATIONS_PATH}/${invitation.id}`,
    });
    expect(hidden.statusCode).toBe(404);

    const owner = await createSession(requireClient(client), OWNER_ID, TENANT_ID);
    const revoked = await server.inject({
      headers: writeHeaders(owner),
      method: 'DELETE',
      url: `${API_INVITATIONS_PATH}/${invitation.id}`,
    });
    expect(revoked.statusCode).toBe(204);

    const secret = 'too-short';
    const invalid = await server.inject({
      headers: writeHeaders(owner),
      method: 'POST',
      payload: { display_name: 'Invalid', password: secret },
      url: `${API_INVITATIONS_PATH}/${'x'.repeat(43)}/accept`,
    });
    expect(invalid.statusCode).toBe(422);
    expect(JSON.stringify(invalid.json())).not.toContain(secret);
    expect(JSON.stringify(invalid.json())).not.toContain('x'.repeat(43));
  });
});

function createInvitationService(
  application: NestFastifyApplication,
  emailAdapter: EmailAdapter,
): InvitationService {
  return new InvitationService(
    application.get(IdentityAuthDatabase),
    application.get(AuthService),
    application.get(PasswordHasher),
    emailAdapter,
  );
}

async function createSession(
  database: Sql,
  userId: string,
  tenantId: string | null,
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

async function bootstrapCsrf(server: FastifyInstance): Promise<string> {
  const response = await server.inject({ method: 'GET', url: `${API_AUTH_PATH}/session` });
  expect(response.statusCode).toBe(401);
  return requireCookie(response.headers['set-cookie'], 'geo_csrf');
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
  if (!application) throw new Error('Invitation test application was not initialized');
  return application;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Invitation test PostgreSQL client was not initialized');
  return client;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
