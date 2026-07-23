import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApplication } from '../../src/application.js';
import { migrateDatabase } from '../../src/database/migrate.js';
import type { AuthSessionPrincipal } from '../../src/modules/identity/auth/auth.service.js';
import { RbacService } from '../../src/modules/identity/rbac/rbac.service.js';

const USER_ID = '10000000-0000-4000-8000-000000000018';
const TENANT_ID = '20000000-0000-4000-8000-000000000018';
const SESSION_ID = '30000000-0000-4000-8000-000000000018';

describe('RBAC role resolution', () => {
  let application: NestFastifyApplication | undefined;
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  let originalDatabaseUrl: string | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 2 });
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
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`TRUNCATE idempotency_records, password_reset_tokens, invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
    await database`
      INSERT INTO users (id, email, display_name, status)
      VALUES (${USER_ID}, 'rbac@example.com', 'RBAC User', 'active')
    `;
    await database`
      INSERT INTO tenants (id, name, slug, status)
      VALUES (${TENANT_ID}, 'RBAC Tenant', 'rbac-tenant', 'active')
    `;
    await database`
      INSERT INTO memberships (tenant_id, user_id, role_code, status)
      VALUES (${TENANT_ID}, ${USER_ID}, 'reviewer', 'active')
    `;
    await database`
      INSERT INTO platform_roles (user_id, role_code, status)
      VALUES
        (${USER_ID}, 'platform_admin', 'active'),
        (${USER_ID}, 'platform_operator', 'active')
    `;
  });

  afterAll(async () => {
    await application?.close();
    await client?.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = originalDatabaseUrl;
  });

  it('combines active platform and current-tenant roles without widening either role', async () => {
    const context = await requireApplication(application).get(RbacService).resolve(principal());

    expect(context.roles).toEqual(['platform_admin', 'platform_operator', 'reviewer']);
    expect(context.platformRoles).toEqual(['platform_admin', 'platform_operator']);
    expect(context.tenantRole).toBe('reviewer');
    expect(context.permissions.has('platform.tenants.manage')).toBe(true);
    expect(context.permissions.has('platform.prompts.manage')).toBe(true);
    expect(context.permissions.has('review.decide')).toBe(true);
    expect(context.permissions.has('content.production.manage')).toBe(false);
    expect(context.permissions.has('audit.export')).toBe(false);
  });

  it('rechecks role, membership, tenant, and user status on every resolution', async () => {
    const database = requireClient(client);
    const service = requireApplication(application).get(RbacService);
    await database`
      UPDATE platform_roles SET status = 'disabled'
      WHERE user_id = ${USER_ID} AND role_code = 'platform_operator'
    `;
    await database`
      UPDATE memberships SET status = 'disabled'
      WHERE tenant_id = ${TENANT_ID} AND user_id = ${USER_ID}
    `;
    const disabled = await service.resolve(principal());
    expect(disabled.roles).toEqual(['platform_admin']);
    expect(disabled.permissions.has('content.read')).toBe(false);

    await database`UPDATE users SET status = 'disabled' WHERE id = ${USER_ID}`;
    const disabledUser = await service.resolve(principal());
    expect(disabledUser.roles).toEqual([]);
    expect(disabledUser.permissions.size).toBe(0);
  });
});

function principal(activeTenantId: string | null = TENANT_ID): AuthSessionPrincipal {
  return {
    activeTenantId,
    sessionId: SESSION_ID,
    userId: USER_ID,
  };
}

function requireApplication(
  application: NestFastifyApplication | undefined,
): NestFastifyApplication {
  if (!application) throw new Error('RBAC test application was not initialized');
  return application;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('RBAC PostgreSQL client was not initialized');
  return client;
}
