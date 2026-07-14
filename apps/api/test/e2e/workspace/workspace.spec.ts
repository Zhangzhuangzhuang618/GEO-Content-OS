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
} from '../identity/runtime.mjs';

const OWNER_ID = '10000000-0000-4000-8000-000000000028';
const SCOPED_EDITOR_ID = '10000000-0000-4000-8000-000000000128';
const OTHER_OWNER_ID = '10000000-0000-4000-8000-000000000228';
const PLATFORM_ADMIN_ID = '10000000-0000-4000-8000-000000000328';
const TENANT_ID = '20000000-0000-4000-8000-000000000028';
const OTHER_TENANT_ID = '20000000-0000-4000-8000-000000000128';
const WORKSPACE_A = '30000000-0000-4000-8000-000000000028';
const WORKSPACE_B = '30000000-0000-4000-8000-000000000128';
const OTHER_WORKSPACE = '30000000-0000-4000-8000-000000000228';
const PROJECT_A = '40000000-0000-4000-8000-000000000028';
const PROJECT_B = '40000000-0000-4000-8000-000000000128';
const PROJECT_C = '40000000-0000-4000-8000-000000000228';
const OTHER_PROJECT = '40000000-0000-4000-8000-000000000328';
const PASSWORD = 'workspace E2E enterprise passphrase';
const API_PREFIX = '/api/v1';

let application: NestFastifyApplication | undefined;
let baseUrl = '';
let client: Sql | undefined;
let container: StartedPostgreSqlContainer | undefined;
let originalDatabaseUrl: string | undefined;
let passwordHash = '';

test.describe('workspace and project scope isolation', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test.beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 6 });
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
    await resetWorkspaceDatabase(requireClient(client), passwordHash);
  });

  test.afterAll(async () => {
    await application?.close();
    await client?.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = originalDatabaseUrl;
  });

  test('paginates tenant-wide workspace and project lists without duplicates or cross-tenant rows', async () => {
    const owner = await login('workspace-owner@example.com');
    await switchTenant(owner, TENANT_ID, 'workspace-owner-tenant');

    const workspaces = await collectCursorPages(owner.api, `${API_PREFIX}/workspaces`, 1);
    expect(workspaces.map((item) => item.id).sort()).toEqual([WORKSPACE_A, WORKSPACE_B].sort());
    expect(workspaces.every((item) => item.tenant_id === TENANT_ID)).toBe(true);
    expect(new Set(workspaces.map((item) => item.id)).size).toBe(workspaces.length);

    const projects = await collectCursorPages(owner.api, `${API_PREFIX}/projects`, 2);
    expect(projects.map((item) => item.id).sort()).toEqual(
      [PROJECT_A, PROJECT_B, PROJECT_C].sort(),
    );
    expect(projects.every((item) => item.tenant_id === TENANT_ID)).toBe(true);
    expect(new Set(projects.map((item) => item.id)).size).toBe(projects.length);
    expect(projects.some((item) => item.id === OTHER_PROJECT)).toBe(false);

    await owner.api.dispose();
  });

  test('enforces workspace and project scope against filtered lists and forged read or write IDs', async () => {
    const editor = await login('workspace-scoped@example.com');
    await switchTenant(editor, TENANT_ID, 'workspace-scoped-tenant');

    const workspaceList = await editor.api.get(`${API_PREFIX}/workspaces`);
    expect(workspaceList.status()).toBe(200);
    expect(readIds(await workspaceList.json())).toEqual([WORKSPACE_A]);

    const projectList = await editor.api.get(`${API_PREFIX}/projects`);
    expect(projectList.status()).toBe(200);
    expect(readIds(await projectList.json())).toEqual([PROJECT_A]);

    const cannotBroaden = await editor.api.get(
      `${API_PREFIX}/projects?workspace_id=${WORKSPACE_B}`,
    );
    expect(cannotBroaden.status()).toBe(200);
    expect(readIds(await cannotBroaden.json())).toEqual([]);

    expect((await editor.api.get(`${API_PREFIX}/projects/${PROJECT_A}`)).status()).toBe(200);
    await expectApiError(
      await editor.api.get(`${API_PREFIX}/projects/${PROJECT_B}`),
      404,
      'RESOURCE_NOT_FOUND',
    );
    await expectApiError(
      await editor.api.get(`${API_PREFIX}/workspaces/${WORKSPACE_B}`),
      404,
      'RESOURCE_NOT_FOUND',
    );
    await expectApiError(
      await editor.api.get(`${API_PREFIX}/projects/${OTHER_PROJECT}`),
      404,
      'RESOURCE_NOT_FOUND',
    );
    await expectApiError(
      await editor.api.get(`${API_PREFIX}/workspaces/${OTHER_WORKSPACE}`),
      404,
      'RESOURCE_NOT_FOUND',
    );

    const forgedWrite = await editor.api.patch(`${API_PREFIX}/projects/${OTHER_PROJECT}`, {
      data: { name: 'Must remain hidden' },
      headers: {
        ...writeHeaders(editor.csrf, 'workspace-forged-project-write'),
        'if-match': '1',
      },
    });
    await expectApiError(forgedWrite, 404, 'RESOURCE_NOT_FOUND');
    await editor.api.dispose();
  });

  test('requires a matching support grant for audited workspace and project reads', async () => {
    const database = requireClient(client);
    const admin = await login('workspace-platform-admin@example.com');
    await expectApiError(
      await admin.api.get(`${API_PREFIX}/workspaces`),
      403,
      'TENANT_CONTEXT_REQUIRED',
    );

    const created = await admin.api.post(`${API_PREFIX}/platform/support-access-grants`, {
      data: {
        expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
        platform_user_id: PLATFORM_ADMIN_ID,
        reason: 'Investigate workspace scope incident INC-28',
        scope: {
          permissions: ['tenant.workspaces.read', 'strategy.read'],
          resource_types: ['workspace', 'project'],
        },
        tenant_id: TENANT_ID,
      },
      headers: writeHeaders(admin.csrf, 'workspace-support-grant'),
    });
    expect(created.status()).toBe(201);
    const grantId = readDataId(await created.json());
    const service = requireApplication(application).get(SupportAccessService);

    const workspaceIds = await service.withTenantAccess(
      {
        action: 'support.workspace.list',
        actorUserId: PLATFORM_ADMIN_ID,
        grantId,
        permission: 'tenant.workspaces.read',
        requestId: 'workspace-e2e-support-workspaces',
        resourceType: 'workspace',
        tenantId: TENANT_ID,
      },
      async (transaction, context) => {
        const rows = await transaction<{ id: string }[]>`
          SELECT id FROM workspaces
          WHERE tenant_id = ${context.tenantId} AND deleted_at IS NULL
          ORDER BY id
        `;
        return rows.map((row) => row.id);
      },
    );
    expect(workspaceIds).toEqual([WORKSPACE_A, WORKSPACE_B].sort());

    const projectIds = await service.withTenantAccess(
      {
        action: 'support.project.list',
        actorUserId: PLATFORM_ADMIN_ID,
        grantId,
        permission: 'strategy.read',
        requestId: 'workspace-e2e-support-projects',
        resourceType: 'project',
        tenantId: TENANT_ID,
      },
      async (transaction, context) => {
        const rows = await transaction<{ id: string }[]>`
          SELECT id FROM projects
          WHERE tenant_id = ${context.tenantId} AND deleted_at IS NULL
          ORDER BY id
        `;
        return rows.map((row) => row.id);
      },
    );
    expect(projectIds).toEqual([PROJECT_A, PROJECT_B, PROJECT_C].sort());

    await expect(
      service.withTenantAccess(
        {
          action: 'support.workspace.denied',
          actorUserId: PLATFORM_ADMIN_ID,
          grantId,
          permission: 'tenant.workspaces.read',
          requestId: 'workspace-e2e-wrong-tenant',
          resourceType: 'workspace',
          tenantId: OTHER_TENANT_ID,
        },
        async () => 'unreachable',
      ),
    ).rejects.toBeInstanceOf(SupportAccessNotFoundError);

    await expect(
      service.withTenantAccess(
        {
          action: 'support.workspace.denied',
          actorUserId: PLATFORM_ADMIN_ID,
          grantId,
          permission: 'content.read',
          requestId: 'workspace-e2e-wrong-permission',
          resourceType: 'workspace',
          tenantId: TENANT_ID,
        },
        async () => 'unreachable',
      ),
    ).rejects.toBeInstanceOf(SupportAccessNotFoundError);

    const audits = await database<{ action: string }[]>`
      SELECT action FROM audit_events
      WHERE support_access_grant_id = ${grantId}
      ORDER BY created_at, id
    `;
    expect(audits.map((audit) => audit.action)).toEqual([
      'support_access.grant.created',
      'support.workspace.list',
      'support.project.list',
    ]);
    await admin.api.dispose();
  });
});

interface AuthenticatedApi {
  readonly api: APIRequestContext;
  readonly csrf: string;
}

interface PageItem {
  readonly id: string;
  readonly tenant_id: string;
}

async function collectCursorPages(
  api: APIRequestContext,
  path: string,
  limit: number,
): Promise<readonly PageItem[]> {
  const items: PageItem[] = [];
  let cursor: string | null = null;
  do {
    const separator = path.includes('?') ? '&' : '?';
    const response = await api.get(
      `${path}${separator}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      readonly data: readonly PageItem[];
      readonly meta: { readonly next_cursor: string | null };
    };
    items.push(...body.data);
    cursor = body.meta.next_cursor;
  } while (cursor);
  return items;
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
): Promise<void> {
  const response = await actor.api.post(`${API_PREFIX}/auth/switch-tenant`, {
    data: { tenant_id: tenantId },
    headers: writeHeaders(actor.csrf, idempotencyKey),
  });
  expect(response.status()).toBe(200);
}

function writeHeaders(csrf: string, idempotencyKey: string) {
  return { 'idempotency-key': idempotencyKey, 'x-csrf-token': csrf };
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

function readIds(value: unknown): readonly string[] {
  return (value as { readonly data: readonly { readonly id: string }[] }).data.map(
    (item) => item.id,
  );
}

function readDataId(value: unknown): string {
  const id = (value as { readonly data?: { readonly id?: unknown } }).data?.id;
  if (typeof id !== 'string') throw new Error('Expected API response data.id');
  return id;
}

async function resetWorkspaceDatabase(database: Sql, hash: string): Promise<void> {
  await database`TRUNCATE brief_sources, brief_keywords, briefs, topic_candidates, generation_runs, keywords, keyword_sets, brand_profiles, workspace_memberships, projects, workspaces, audit_events, support_access_grants, idempotency_records, password_reset_tokens, invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
  await database`
    INSERT INTO users (id, email, password_hash, display_name, status)
    VALUES
      (${OWNER_ID}, 'workspace-owner@example.com', ${hash}, 'Workspace Owner', 'active'),
      (${SCOPED_EDITOR_ID}, 'workspace-scoped@example.com', ${hash}, 'Scoped Editor', 'active'),
      (${OTHER_OWNER_ID}, 'workspace-other-owner@example.com', ${hash}, 'Other Owner', 'active'),
      (${PLATFORM_ADMIN_ID}, 'workspace-platform-admin@example.com', ${hash}, 'Platform Admin', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status)
    VALUES
      (${TENANT_ID}, 'Workspace E2E Tenant', 'workspace-e2e', 'active'),
      (${OTHER_TENANT_ID}, 'Other Workspace E2E Tenant', 'other-workspace-e2e', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status)
    VALUES
      (${TENANT_ID}, ${OWNER_ID}, 'tenant_owner', 'active'),
      (${TENANT_ID}, ${SCOPED_EDITOR_ID}, 'strategy_editor', 'active'),
      (${OTHER_TENANT_ID}, ${OTHER_OWNER_ID}, 'tenant_owner', 'active')
  `;
  await database`
    INSERT INTO platform_roles (user_id, role_code, status)
    VALUES (${PLATFORM_ADMIN_ID}, 'platform_admin', 'active')
  `;
  await database`
    INSERT INTO workspaces (id, tenant_id, name, slug, timezone)
    VALUES
      (${WORKSPACE_A}, ${TENANT_ID}, 'Workspace A', 'workspace-a', 'UTC'),
      (${WORKSPACE_B}, ${TENANT_ID}, 'Workspace B', 'workspace-b', 'UTC'),
      (${OTHER_WORKSPACE}, ${OTHER_TENANT_ID}, 'Other Workspace', 'other-workspace', 'UTC')
  `;
  await database`
    INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id)
    VALUES
      (${PROJECT_A}, ${TENANT_ID}, ${WORKSPACE_A}, 'Project A', ${OWNER_ID}),
      (${PROJECT_B}, ${TENANT_ID}, ${WORKSPACE_A}, 'Project B', ${OWNER_ID}),
      (${PROJECT_C}, ${TENANT_ID}, ${WORKSPACE_B}, 'Project C', ${OWNER_ID}),
      (${OTHER_PROJECT}, ${OTHER_TENANT_ID}, ${OTHER_WORKSPACE}, 'Other Project', ${OTHER_OWNER_ID})
  `;
  await database`
    INSERT INTO workspace_memberships (workspace_id, user_id, scope_json)
    VALUES (
      ${WORKSPACE_A},
      ${SCOPED_EDITOR_ID},
      ${JSON.stringify({ project_ids: [PROJECT_A], schema_version: 'workspace-scope@1' })}::text::jsonb
    )
  `;
}

function requireApplication(value: NestFastifyApplication | undefined): NestFastifyApplication {
  if (!value) throw new Error('Workspace E2E application was not initialized');
  return value;
}

function requireClient(value: Sql | undefined): Sql {
  if (!value) throw new Error('Workspace E2E PostgreSQL client was not initialized');
  return value;
}
