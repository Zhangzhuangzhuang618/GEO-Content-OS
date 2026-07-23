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

const OWNER = '10000000-0000-4000-8000-000000000100';
const ADMIN = '11000000-0000-4000-8000-000000000100';
const TENANT = '20000000-0000-4000-8000-000000000100';
const OTHER_TENANT = '21000000-0000-4000-8000-000000000100';
const RESOURCE = '30000000-0000-4000-8000-000000000100';

describe('tenant audit query API', () => {
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
      TRUNCATE audit_events, sessions, platform_roles, memberships, tenants, users CASCADE
    `;
    await database`
      INSERT INTO users (id,email,display_name,status) VALUES
        (${OWNER},'owner@example.com','Tenant Owner','active'),
        (${ADMIN},'admin@example.com','Tenant Admin','active')
    `;
    await database`
      INSERT INTO tenants (id,name,slug,status) VALUES
        (${TENANT},'Audit Tenant','audit-tenant','active'),
        (${OTHER_TENANT},'Other Tenant','other-tenant','active')
    `;
    await database`
      INSERT INTO memberships (tenant_id,user_id,role_code,status) VALUES
        (${TENANT},${OWNER},'tenant_owner','active'),
        (${TENANT},${ADMIN},'tenant_admin','active')
    `;
    await database`
      INSERT INTO audit_events (
        id,tenant_id,actor_id,action,resource_type,resource_id,
        before_json,after_json,ip,request_id,created_at
      ) VALUES
        (
          '40000000-0000-4000-8000-000000000100',${TENANT},${OWNER},
          'workspace.updated','workspace',${RESOURCE},
          '{"name":"Before","password":"legacy-secret"}',
          '{"name":"After","access_token":"platform-secret"}',
          '127.0.0.1','req-new','2026-07-16T02:00:00Z'
        ),
        (
          '41000000-0000-4000-8000-000000000100',${TENANT},NULL,
          'workspace.created','workspace',${RESOURCE},
          NULL,'{"name":"Before"}',NULL,'req-old','2026-07-16T01:00:00Z'
        ),
        (
          '42000000-0000-4000-8000-000000000100',${OTHER_TENANT},${OWNER},
          'workspace.updated','workspace',${RESOURCE},
          NULL,'{"name":"Other tenant"}',NULL,'req-other','2026-07-16T03:00:00Z'
        )
    `;
  });

  afterAll(async () => {
    await application?.close();
    await client?.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = originalDatabaseUrl;
  });

  it('filters, paginates, redacts and isolates tenant audit events for an owner', async () => {
    const database = requireClient(client);
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const owner = await createSession(database, OWNER, TENANT);
    const first = await server.inject({
      headers: readHeaders(owner),
      method: 'GET',
      url: '/api/v1/audit-events?action=workspace.updated&limit=1',
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.items).toEqual([
      expect.objectContaining({
        action: 'workspace.updated',
        actor_id: OWNER,
        actor_name: 'Tenant Owner',
        after: { access_token: '[REDACTED]', name: 'After' },
        before: { name: 'Before', password: '[REDACTED]' },
        request_id: 'req-new',
      }),
    ]);
    expect(JSON.stringify(first.json())).not.toContain('Other tenant');
    expect(JSON.stringify(first.json())).not.toContain('platform-secret');
    expect(JSON.stringify(first.json())).not.toContain('legacy-secret');

    const page = await server.inject({
      headers: readHeaders(owner),
      method: 'GET',
      url: '/api/v1/audit-events?limit=1',
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().data.next_cursor).toEqual(expect.any(String));
    const next = await server.inject({
      headers: readHeaders(owner),
      method: 'GET',
      url: `/api/v1/audit-events?limit=1&cursor=${page.json().data.next_cursor as string}`,
    });
    expect(next.statusCode).toBe(200);
    expect(next.json().data.items[0].request_id).toBe('req-old');
  });

  it('denies tenant admins and rejects invalid filters', async () => {
    const database = requireClient(client);
    const server = requireApplication(application).getHttpAdapter().getInstance();
    const admin = await createSession(database, ADMIN, TENANT);
    const forbidden = await server.inject({
      headers: readHeaders(admin),
      method: 'GET',
      url: '/api/v1/audit-events',
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('PERMISSION_DENIED');

    const owner = await createSession(database, OWNER, TENANT);
    const invalid = await server.inject({
      headers: readHeaders(owner),
      method: 'GET',
      url: '/api/v1/audit-events?from=2026-07-17T00%3A00%3A00.000Z&to=2026-07-16T00%3A00%3A00.000Z',
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.code).toBe('SCHEMA_VALIDATION_FAILED');
  });

  it('keeps audit history append-only at the database boundary', async () => {
    const database = requireClient(client);
    await expect(
      database`
        UPDATE audit_events SET action='workspace.deleted'
        WHERE request_id='req-new'
      `,
    ).rejects.toThrow(/append-only/u);
    await expect(database`DELETE FROM audit_events WHERE request_id='req-new'`).rejects.toThrow(
      /append-only/u,
    );
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireApplication(value: NestFastifyApplication | undefined) {
  if (!value) throw new Error('Audit query test application was not initialized');
  return value;
}

function requireClient(value: Sql | undefined) {
  if (!value) throw new Error('Audit query test PostgreSQL client was not initialized');
  return value;
}
