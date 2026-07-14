import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type APIResponse,
} from '@playwright/test';
import postgres, { type Sql } from 'postgres';

import {
  createApplication,
  migrateDatabase,
  PasswordHasher,
  SupportAccessNotFoundError,
  SupportAccessService,
} from './runtime.mjs';

const OWNER_ID = '10000000-0000-4000-8000-000000000020';
const REVIEWER_ID = '10000000-0000-4000-8000-000000000120';
const OTHER_OWNER_ID = '10000000-0000-4000-8000-000000000220';
const PLATFORM_ADMIN_ID = '10000000-0000-4000-8000-000000000320';
const PLATFORM_OPERATOR_ID = '10000000-0000-4000-8000-000000000420';
const TENANT_A_ID = '20000000-0000-4000-8000-000000000020';
const TENANT_B_ID = '20000000-0000-4000-8000-000000000120';
const HIDDEN_TENANT_ID = '20000000-0000-4000-8000-000000000220';
const CROSS_TENANT_INVITATION_ID = '40000000-0000-4000-8000-000000000020';
const PASSWORD = 'identity E2E enterprise passphrase';
const API_PREFIX = '/api/v1';

let application: NestFastifyApplication | undefined;
let baseUrl = '';
let client: Sql | undefined;
let container: StartedPostgreSqlContainer | undefined;
let originalDatabaseUrl: string | undefined;
let passwordHash = '';

test.describe('identity roles and cross-tenant isolation', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test.beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 4 });
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
    await application.listen(0, '127.0.0.1');
    baseUrl = await application.getUrl();
  });

  test.beforeEach(async () => {
    await resetIdentityDatabase(requireClient(client), passwordHash);
  });

  test.afterAll(async () => {
    await application?.close();
    await client?.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = originalDatabaseUrl;
  });

  test('returns exact 401, 403, and tenant-hiding 404 envelopes', async () => {
    const anonymous = await newApiContext();
    const unauthenticated = await anonymous.get(`${API_PREFIX}/auth/tenants`);
    await expectApiError(unauthenticated, 401, 'AUTH_REQUIRED');
    await anonymous.dispose();

    const operator = await login('platform-operator@example.com');
    const forbidden = await operator.api.post(`${API_PREFIX}/platform/support-access-grants`, {
      data: supportGrantPayload(),
      headers: writeHeaders(operator.csrf, 'operator-cannot-grant'),
    });
    await expectApiError(forbidden, 403, 'PERMISSION_DENIED');

    const owner = await login('owner@example.com');
    const hidden = await owner.api.post(`${API_PREFIX}/auth/switch-tenant`, {
      data: { tenant_id: HIDDEN_TENANT_ID },
      headers: writeHeaders(owner.csrf, 'hidden-tenant-switch'),
    });
    await expectApiError(hidden, 404, 'RESOURCE_NOT_FOUND');

    await switchTenant(owner, TENANT_A_ID, 'owner-tenant-a');
    const crossTenantDelete = await owner.api.delete(
      `${API_PREFIX}/invitations/${CROSS_TENANT_INVITATION_ID}`,
      { headers: { 'x-csrf-token': owner.csrf } },
    );
    await expectApiError(crossTenantDelete, 404, 'RESOURCE_NOT_FOUND');
    await Promise.all([operator.api.dispose(), owner.api.dispose()]);
  });

  test('switches only among active memberships and replays the same transition idempotently', async () => {
    const owner = await login('owner@example.com');
    const available = await owner.api.get(`${API_PREFIX}/auth/tenants`);
    expect(available.status()).toBe(200);
    const initial = (await available.json()) as TenantChoicesResponse;
    expect(initial.data.map((tenant) => tenant.id)).toEqual([TENANT_A_ID, TENANT_B_ID]);

    const first = await switchTenant(owner, TENANT_B_ID, 'switch-to-b');
    expect(first.data.active_tenant_id).toBe(TENANT_B_ID);
    const replay = await switchTenant(owner, TENANT_B_ID, 'switch-to-b');
    expect(replay.data.active_tenant_id).toBe(TENANT_B_ID);
    const session = await owner.api.get(`${API_PREFIX}/auth/session`);
    expect(session.status()).toBe(200);
    expect(((await session.json()) as SessionResponse).data.active_tenant_id).toBe(TENANT_B_ID);
    await owner.api.dispose();
  });

  test('invalidates tenant access after membership disablement but permits safe recovery', async () => {
    const database = requireClient(client);
    const owner = await login('owner@example.com');
    await switchTenant(owner, TENANT_A_ID, 'activate-a-before-disable');
    await database`
      UPDATE memberships SET status = 'disabled'
      WHERE tenant_id = ${TENANT_A_ID} AND user_id = ${OWNER_ID}
    `;

    const tenantWrite = await owner.api.post(`${API_PREFIX}/invitations`, {
      data: {
        email: 'blocked@example.com',
        role_code: 'viewer',
        workspace_scope: {},
      },
      headers: writeHeaders(owner.csrf, 'disabled-member-write'),
    });
    await expectApiError(tenantWrite, 401, 'AUTH_REQUIRED');

    const choices = await owner.api.get(`${API_PREFIX}/auth/tenants`);
    expect(choices.status()).toBe(200);
    const body = (await choices.json()) as TenantChoicesResponse;
    expect(body.data.map((tenant) => tenant.id)).toEqual([TENANT_B_ID]);
    const recovered = await switchTenant(owner, TENANT_B_ID, 'recover-to-b');
    expect(recovered.data.active_tenant_id).toBe(TENANT_B_ID);
    await owner.api.dispose();
  });

  test('enforces tenant roles after a valid tenant switch', async () => {
    const reviewer = await login('reviewer@example.com');
    await switchTenant(reviewer, TENANT_A_ID, 'reviewer-to-a');
    const invite = await reviewer.api.post(`${API_PREFIX}/invitations`, {
      data: {
        email: 'reviewer-cannot-invite@example.com',
        role_code: 'viewer',
        workspace_scope: {},
      },
      headers: writeHeaders(reviewer.csrf, 'reviewer-invite'),
    });
    await expectApiError(invite, 403, 'PERMISSION_DENIED');
    await reviewer.api.dispose();
  });

  test('grants scoped support access, audits its read, and denies missing or revoked grants', async () => {
    const database = requireClient(client);
    const admin = await login('platform-admin@example.com');
    const created = await admin.api.post(`${API_PREFIX}/platform/support-access-grants`, {
      data: supportGrantPayload(),
      headers: writeHeaders(admin.csrf, 'admin-support-grant'),
    });
    expect(created.status()).toBe(201);
    const grant = (await created.json()) as SupportGrantResponse;
    const service = requireApplication(application).get(SupportAccessService);
    const tenantName = await service.withTenantAccess(
      {
        action: 'support.tenant.read',
        actorUserId: PLATFORM_ADMIN_ID,
        grantId: grant.data.id,
        permission: 'content.read',
        requestId: 'identity-e2e-support-read',
        resourceId: TENANT_A_ID,
        resourceType: 'tenant',
        tenantId: TENANT_A_ID,
      },
      async (transaction, context) => {
        const rows = await transaction<{ name: string }[]>`
          SELECT name FROM tenants WHERE id = ${context.tenantId}
        `;
        return rows[0]?.name;
      },
    );
    expect(tenantName).toBe('Tenant A');
    const audits = await database<{ action: string; requestId: string }[]>`
      SELECT action, request_id AS "requestId"
      FROM audit_events
      WHERE support_access_grant_id = ${grant.data.id}
      ORDER BY created_at
    `;
    expect(audits).toEqual([
      { action: 'support_access.grant.created', requestId: expect.any(String) },
      { action: 'support.tenant.read', requestId: 'identity-e2e-support-read' },
    ]);

    await expect(
      service.withTenantAccess(
        {
          action: 'support.tenant.read',
          actorUserId: PLATFORM_ADMIN_ID,
          grantId: '50000000-0000-4000-8000-000000000020',
          permission: 'content.read',
          requestId: 'missing-support-grant',
          resourceType: 'tenant',
          tenantId: TENANT_A_ID,
        },
        async () => 'unreachable',
      ),
    ).rejects.toBeInstanceOf(SupportAccessNotFoundError);

    await service.revokeGrant(PLATFORM_ADMIN_ID, grant.data.id, {
      requestId: 'identity-e2e-revoke',
    });
    await expect(
      service.withTenantAccess(
        {
          action: 'support.tenant.read',
          actorUserId: PLATFORM_ADMIN_ID,
          grantId: grant.data.id,
          permission: 'content.read',
          requestId: 'revoked-support-grant',
          resourceType: 'tenant',
          tenantId: TENANT_A_ID,
        },
        async () => 'unreachable',
      ),
    ).rejects.toBeInstanceOf(SupportAccessNotFoundError);
    await admin.api.dispose();
  });
});

interface AuthenticatedApi {
  readonly api: APIRequestContext;
  readonly csrf: string;
}

interface SessionResponse {
  readonly data: { readonly active_tenant_id: string | null };
}

interface SupportGrantResponse {
  readonly data: { readonly id: string };
}

interface TenantChoicesResponse {
  readonly data: readonly { readonly id: string }[];
}

async function newApiContext(): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL: baseUrl });
}

async function login(email: string): Promise<AuthenticatedApi> {
  const preAuthApi = await newApiContext();
  const bootstrap = await preAuthApi.get(`${API_PREFIX}/auth/session`);
  expect(bootstrap.status()).toBe(401);
  const preAuthCsrf = responseCookie(bootstrap, 'geo_csrf');
  if (!preAuthCsrf) throw new Error('CSRF bootstrap did not issue a cookie');
  const response = await preAuthApi.post(`${API_PREFIX}/auth/login`, {
    data: { email, password: PASSWORD, remember_me: false },
    headers: {
      cookie: `geo_csrf=${preAuthCsrf}`,
      'x-csrf-token': preAuthCsrf,
    },
  });
  if (response.status() !== 200) {
    throw new Error(`Login for ${email} failed: ${response.status()} ${await response.text()}`);
  }
  const csrf = responseCookie(response, 'geo_csrf');
  const session = responseCookie(response, 'geo_session');
  if (!csrf || !session) throw new Error(`Login for ${email} did not issue hardened cookies`);
  await preAuthApi.dispose();
  const api = await playwrightRequest.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { cookie: `geo_session=${session}; geo_csrf=${csrf}` },
  });
  return { api, csrf };
}

function responseCookie(response: APIResponse, name: string): string | undefined {
  for (const header of response.headersArray()) {
    if (header.name.toLowerCase() !== 'set-cookie') continue;
    const [pair] = header.value.split(';', 1);
    if (pair?.startsWith(`${name}=`)) return pair.slice(name.length + 1);
  }
  return undefined;
}

async function switchTenant(
  actor: AuthenticatedApi,
  tenantId: string,
  idempotencyKey: string,
): Promise<SessionResponse> {
  const response = await actor.api.post(`${API_PREFIX}/auth/switch-tenant`, {
    data: { tenant_id: tenantId },
    headers: writeHeaders(actor.csrf, idempotencyKey),
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as SessionResponse;
}

function writeHeaders(csrf: string, idempotencyKey: string) {
  return { 'idempotency-key': idempotencyKey, 'x-csrf-token': csrf };
}

function supportGrantPayload() {
  return {
    expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    platform_user_id: PLATFORM_ADMIN_ID,
    reason: 'Identity E2E support access verification',
    scope: { permissions: ['content.read'], resource_types: ['tenant'] },
    tenant_id: TENANT_A_ID,
  };
}

async function expectApiError(
  response: { json(): Promise<unknown>; status(): number },
  status: number,
  code: string,
): Promise<void> {
  expect(response.status()).toBe(status);
  const body = (await response.json()) as { error?: { code?: string; request_id?: string } };
  expect(body.error).toMatchObject({ code, request_id: expect.any(String) });
}

async function resetIdentityDatabase(database: Sql, hash: string): Promise<void> {
  await database`TRUNCATE topic_candidates, generation_runs, keywords, keyword_sets, brand_profiles, workspace_memberships, projects, workspaces, audit_events, support_access_grants, idempotency_records, password_reset_tokens, invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
  await database`
    INSERT INTO users (id, email, password_hash, display_name, status)
    VALUES
      (${OWNER_ID}, 'owner@example.com', ${hash}, 'Tenant Owner', 'active'),
      (${REVIEWER_ID}, 'reviewer@example.com', ${hash}, 'Reviewer', 'active'),
      (${OTHER_OWNER_ID}, 'other-owner@example.com', ${hash}, 'Other Owner', 'active'),
      (${PLATFORM_ADMIN_ID}, 'platform-admin@example.com', ${hash}, 'Platform Admin', 'active'),
      (${PLATFORM_OPERATOR_ID}, 'platform-operator@example.com', ${hash}, 'Platform Operator', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status)
    VALUES
      (${TENANT_A_ID}, 'Tenant A', 'tenant-a', 'active'),
      (${TENANT_B_ID}, 'Tenant B', 'tenant-b', 'active'),
      (${HIDDEN_TENANT_ID}, 'Hidden Tenant', 'hidden-tenant', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status)
    VALUES
      (${TENANT_A_ID}, ${OWNER_ID}, 'tenant_owner', 'active'),
      (${TENANT_B_ID}, ${OWNER_ID}, 'reviewer', 'active'),
      (${TENANT_A_ID}, ${REVIEWER_ID}, 'reviewer', 'active'),
      (${TENANT_B_ID}, ${OTHER_OWNER_ID}, 'tenant_owner', 'active')
  `;
  await database`
    INSERT INTO platform_roles (user_id, role_code, status)
    VALUES
      (${PLATFORM_ADMIN_ID}, 'platform_admin', 'active'),
      (${PLATFORM_OPERATOR_ID}, 'platform_operator', 'active')
  `;
  await database`
    INSERT INTO invitations (
      id, tenant_id, email, role_code, token_hash, expires_at, invited_by
    ) VALUES (
      ${CROSS_TENANT_INVITATION_ID}, ${TENANT_B_ID}, 'cross-tenant@example.com', 'viewer',
      repeat('a', 64), now() + interval '72 hours', ${OTHER_OWNER_ID}
    )
  `;
}

function requireApplication(value: NestFastifyApplication | undefined): NestFastifyApplication {
  if (!value) throw new Error('Identity E2E application was not initialized');
  return value;
}

function requireClient(value: Sql | undefined): Sql {
  if (!value) throw new Error('Identity E2E PostgreSQL client was not initialized');
  return value;
}
