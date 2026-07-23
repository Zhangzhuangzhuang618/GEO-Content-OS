import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import { IdentityRepository } from '../../src/modules/identity/repositories/identity.repository.js';
import { IDENTITY_SEED, seedIdentity } from '../../src/modules/identity/seeds/identity.seed.js';

const SECOND_TENANT_ID = '20000000-0000-4000-8000-000000000002';

describe('identity-db frozen schema', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let client: Sql | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 2 });
  }, 120_000);

  beforeEach(async () => {
    if (!client) throw new Error('PostgreSQL identity fixture was not initialized');
    await client`TRUNCATE invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('creates all six frozen tables and an idempotent passwordless demo seed', async () => {
    const database = requireClient(client);
    await seedIdentity(database);
    await seedIdentity(database);

    const tables = await database<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('users', 'platform_roles', 'tenants', 'memberships', 'sessions', 'invitations')
      ORDER BY table_name
    `;
    const users = await database<{ count: number; password_hash: string | null; status: string }[]>`
      SELECT count(*)::integer AS count, min(password_hash) AS password_hash, min(status) AS status
      FROM users
    `;
    const memberships = await database<{ count: number; role_code: string; status: string }[]>`
      SELECT count(*)::integer AS count, min(role_code) AS role_code, min(status) AS status
      FROM memberships
    `;

    expect(tables.map(({ table_name }) => table_name)).toEqual([
      'invitations',
      'memberships',
      'platform_roles',
      'sessions',
      'tenants',
      'users',
    ]);
    expect(users[0]).toEqual({ count: 1, password_hash: null, status: 'invited' });
    expect(memberships[0]).toEqual({ count: 1, role_code: 'tenant_owner', status: 'active' });

    await database`UPDATE users SET display_name = '发生漂移' WHERE id = ${IDENTITY_SEED.userId}`;
    await expect(seedIdentity(database)).rejects.toThrow('Identity seed conflicts');
  });

  it('enforces role, status, digest, expiry, and active-membership constraints', async () => {
    const database = requireClient(client);
    await seedIdentity(database);
    await database`
      INSERT INTO tenants (id, name, slug)
      VALUES (${SECOND_TENANT_ID}, '第二租户', 'second-tenant')
    `;

    await expect(
      database`
        INSERT INTO memberships (tenant_id, user_id, role_code, status)
        VALUES (${SECOND_TENANT_ID}, ${IDENTITY_SEED.userId}, 'root', 'active')
      `,
    ).rejects.toThrow(/memberships_role_code_check/u);
    await expect(
      database`
        INSERT INTO sessions (
          user_id, active_tenant_id, session_hash, csrf_hash, expires_at
        ) VALUES (
          ${IDENTITY_SEED.userId},
          ${SECOND_TENANT_ID},
          ${'a'.repeat(64)},
          ${'b'.repeat(64)},
          now() + interval '1 hour'
        )
      `,
    ).rejects.toThrow(/sessions_active_membership_fk/u);
    await expect(
      database`
        INSERT INTO invitations (
          tenant_id, email, role_code, token_hash, expires_at, invited_by
        ) VALUES (
          ${IDENTITY_SEED.tenantId},
          'member@example.com',
          'viewer',
          'not-a-sha256',
          now() + interval '72 hours',
          ${IDENTITY_SEED.userId}
        )
      `,
    ).rejects.toThrow(/invitations_token_hash_check/u);

    const sessions = await database<{ id: string }[]>`
      INSERT INTO sessions (
        user_id, active_tenant_id, session_hash, csrf_hash, expires_at, ip, user_agent
      ) VALUES (
        ${IDENTITY_SEED.userId},
        ${IDENTITY_SEED.tenantId},
        ${'c'.repeat(64)},
        ${'d'.repeat(64)},
        now() + interval '1 hour',
        '127.0.0.1',
        'identity-test'
      )
      RETURNING id
    `;
    expect(sessions).toHaveLength(1);
  });

  it('uses case-insensitive active-only uniqueness and database updated_at triggers', async () => {
    const database = requireClient(client);
    await seedIdentity(database);

    await expect(
      database`
        INSERT INTO users (email, display_name)
        VALUES ('OWNER@example.com', '重复用户')
      `,
    ).rejects.toThrow(/users_email_active_uq/u);
    await database`UPDATE users SET deleted_at = now() WHERE id = ${IDENTITY_SEED.userId}`;
    await database`
      INSERT INTO users (email, display_name)
      VALUES ('OWNER@example.com', '复用邮箱')
    `;

    const before = await database<{ updated_at: Date }[]>`
      SELECT updated_at FROM tenants WHERE id = ${IDENTITY_SEED.tenantId}
    `;
    await database`SELECT pg_sleep(0.01)`;
    await database`
      UPDATE tenants SET name = '示例科技更新' WHERE id = ${IDENTITY_SEED.tenantId}
    `;
    const after = await database<{ updated_at: Date }[]>`
      SELECT updated_at FROM tenants WHERE id = ${IDENTITY_SEED.tenantId}
    `;
    expect(after[0]!.updated_at.getTime()).toBeGreaterThan(before[0]!.updated_at.getTime());
  });

  it('provides scoped repository reads without exposing password hashes by default', async () => {
    const database = requireClient(client);
    await seedIdentity(database);
    const repository = new IdentityRepository(database);

    const user = await repository.findUserByEmail('OWNER@EXAMPLE.COM');
    const authenticationUser = await repository.findAuthenticationUserByEmail('owner@example.com');
    const membership = await repository.findActiveMembership(
      IDENTITY_SEED.userId,
      IDENTITY_SEED.tenantId,
    );
    const tenantChoices = await repository.listActiveTenantChoices(IDENTITY_SEED.userId);

    expect(user).toMatchObject({
      displayName: '示例Owner',
      email: 'owner@example.com',
      id: IDENTITY_SEED.userId,
      status: 'invited',
    });
    expect(user).not.toHaveProperty('passwordHash');
    expect(authenticationUser?.passwordHash).toBeNull();
    expect(membership).toMatchObject({
      roleCode: 'tenant_owner',
      tenantId: IDENTITY_SEED.tenantId,
      tenantSlug: 'demo-tech',
    });
    expect(tenantChoices).toHaveLength(1);
  });
});

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('PostgreSQL identity fixture was not initialized');
  return client;
}
