import { BrandProfilePageSchema, BrandProfileResponseSchema } from '@geo-content-os/contracts';
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

const OWNER_ID = '10000000-0000-4000-8000-000000000024';
const STRATEGY_ID = '10000000-0000-4000-8000-000000000124';
const CONTENT_ID = '10000000-0000-4000-8000-000000000224';
const VIEWER_ID = '10000000-0000-4000-8000-000000000324';
const OTHER_OWNER_ID = '10000000-0000-4000-8000-000000000424';
const TENANT_ID = '20000000-0000-4000-8000-000000000024';
const OTHER_TENANT_ID = '20000000-0000-4000-8000-000000000124';
const WORKSPACE_A = '30000000-0000-4000-8000-000000000024';
const WORKSPACE_B = '30000000-0000-4000-8000-000000000124';
const OTHER_WORKSPACE = '30000000-0000-4000-8000-000000000224';
const API_PATH = '/api/v1/brand-profiles';

describe('brand profiles API', () => {
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
    await database`TRUNCATE topic_candidates, generation_runs, keywords, keyword_sets, brand_profiles, workspace_memberships, projects, workspaces, audit_events, support_access_grants, idempotency_records, password_reset_tokens, invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
    await database`
      INSERT INTO users (id, email, display_name, status)
      VALUES
        (${OWNER_ID}, 'brand-owner@example.com', 'Brand Owner', 'active'),
        (${STRATEGY_ID}, 'brand-strategy@example.com', 'Brand Strategy', 'active'),
        (${CONTENT_ID}, 'brand-content@example.com', 'Brand Content', 'active'),
        (${VIEWER_ID}, 'brand-viewer@example.com', 'Brand Viewer', 'active'),
        (${OTHER_OWNER_ID}, 'other-brand-owner@example.com', 'Other Brand Owner', 'active')
    `;
    await database`
      INSERT INTO tenants (id, name, slug, status)
      VALUES
        (${TENANT_ID}, 'Brand Tenant', 'brand-api-tenant', 'active'),
        (${OTHER_TENANT_ID}, 'Other Brand Tenant', 'other-brand-api-tenant', 'active')
    `;
    await database`
      INSERT INTO memberships (tenant_id, user_id, role_code, status)
      VALUES
        (${TENANT_ID}, ${OWNER_ID}, 'tenant_owner', 'active'),
        (${TENANT_ID}, ${STRATEGY_ID}, 'strategy_editor', 'active'),
        (${TENANT_ID}, ${CONTENT_ID}, 'content_editor', 'active'),
        (${TENANT_ID}, ${VIEWER_ID}, 'viewer', 'active'),
        (${OTHER_TENANT_ID}, ${OTHER_OWNER_ID}, 'tenant_owner', 'active')
    `;
    await database`
      INSERT INTO workspaces (id, tenant_id, name, slug, timezone)
      VALUES
        (${WORKSPACE_A}, ${TENANT_ID}, 'Brand Workspace A', 'brand-a', 'UTC'),
        (${WORKSPACE_B}, ${TENANT_ID}, 'Brand Workspace B', 'brand-b', 'UTC'),
        (${OTHER_WORKSPACE}, ${OTHER_TENANT_ID}, 'Other Brand Workspace', 'other-brand', 'UTC')
    `;
  });

  afterAll(async () => {
    await application?.close();
    await client?.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = originalDatabaseUrl;
  });

  it('validates brand-profile@1 in API and database and allocates immutable versions idempotently', async () => {
    const database = requireClient(client);
    const server = requireServer(application);
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    const payload = createPayload(WORKSPACE_A, 'Evidence-led enterprise GEO');
    const headers = { ...writeHeaders(strategy), 'idempotency-key': 'brand-create-001' };
    const first = await server.inject({ headers, method: 'POST', payload, url: API_PATH });
    const replay = await server.inject({ headers, method: 'POST', payload, url: API_PATH });
    expect(first.statusCode).toBe(201);
    expect(BrandProfileResponseSchema.safeParse(first.json()).success).toBe(true);
    expect(first.json().data).toMatchObject({ status: 'draft', version: 1 });
    expect(first.headers.etag).toBe('"1"');
    expect(replay.json().data.id).toBe(first.json().data.id);

    const [second, third] = await Promise.all([
      server.inject({
        headers: { ...writeHeaders(strategy), 'idempotency-key': 'brand-create-002' },
        method: 'POST',
        payload: createPayload(WORKSPACE_A, 'Second immutable strategy'),
        url: API_PATH,
      }),
      server.inject({
        headers: { ...writeHeaders(strategy), 'idempotency-key': 'brand-create-003' },
        method: 'POST',
        payload: createPayload(WORKSPACE_A, 'Third immutable strategy'),
        url: API_PATH,
      }),
    ]);
    expect([second.json().data.version, third.json().data.version].sort()).toEqual([2, 3]);

    const invalid = await server.inject({
      headers: { ...writeHeaders(strategy), 'idempotency-key': 'brand-create-004' },
      method: 'POST',
      payload: { profile: { positioning: 'Incomplete' }, workspace_id: WORKSPACE_A },
      url: API_PATH,
    });
    expect(invalid.statusCode).toBe(422);
    await expect(
      database`
        INSERT INTO brand_profiles (
          tenant_id, workspace_id, version, schema_version, profile_json, created_by
        ) VALUES (${TENANT_ID}, ${WORKSPACE_A}, 99, 'brand-profile@1', '{}', ${OWNER_ID})
      `,
    ).rejects.toThrow(/brand_profiles_profile_check/u);
    await expect(
      database`
        UPDATE brand_profiles SET profile_json = ${JSON.stringify(profile('Changed'))}::text::jsonb
        WHERE id = ${first.json().data.id}
      `,
    ).rejects.toThrow(/immutable/u);

    const content = await createSession(database, CONTENT_ID, TENANT_ID);
    const forbidden = await server.inject({
      headers: { ...writeHeaders(content), 'idempotency-key': 'brand-create-005' },
      method: 'POST',
      payload,
      url: API_PATH,
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('applies workspace scope to lists and hides cross-tenant profile identifiers', async () => {
    const database = requireClient(client);
    const first = await insertProfile(database, TENANT_ID, WORKSPACE_A, OWNER_ID, 1, 'A1');
    await insertProfile(database, TENANT_ID, WORKSPACE_A, OWNER_ID, 2, 'A2');
    await insertProfile(database, TENANT_ID, WORKSPACE_B, OWNER_ID, 1, 'B1');
    const hidden = await insertProfile(
      database,
      OTHER_TENANT_ID,
      OTHER_WORKSPACE,
      OTHER_OWNER_ID,
      1,
      'Hidden',
    );
    await database`
      INSERT INTO workspace_memberships (workspace_id, user_id, scope_json)
      VALUES (
        ${WORKSPACE_A},
        ${VIEWER_ID},
        ${JSON.stringify({ project_ids: [], schema_version: 'workspace-scope@1' })}::text::jsonb
      )
    `;
    const viewer = await createSession(database, VIEWER_ID, TENANT_ID);
    const page = await requireServer(application).inject({
      headers: readHeaders(viewer),
      method: 'GET',
      url: `${API_PATH}?limit=1`,
    });
    expect(page.statusCode).toBe(200);
    expect(BrandProfilePageSchema.safeParse(page.json()).success).toBe(true);
    expect(page.json().data).toHaveLength(1);
    expect(page.json().data[0].workspace_id).toBe(WORKSPACE_A);
    const next = await requireServer(application).inject({
      headers: readHeaders(viewer),
      method: 'GET',
      url: `${API_PATH}?limit=1&cursor=${encodeURIComponent(page.json().meta.next_cursor)}`,
    });
    expect(next.statusCode).toBe(200);
    expect(next.json().data).toHaveLength(1);

    const visible = await requireServer(application).inject({
      headers: readHeaders(viewer),
      method: 'GET',
      url: `${API_PATH}/${first}`,
    });
    expect(visible.statusCode).toBe(200);
    const crossTenant = await requireServer(application).inject({
      headers: readHeaders(viewer),
      method: 'GET',
      url: `${API_PATH}/${hidden}`,
    });
    expect(crossTenant.statusCode).toBe(404);
  });

  it('publishes a draft atomically, retires the old published version, and replays safely', async () => {
    const database = requireClient(client);
    const first = await insertProfile(database, TENANT_ID, WORKSPACE_A, OWNER_ID, 1, 'V1');
    const second = await insertProfile(database, TENANT_ID, WORKSPACE_A, OWNER_ID, 2, 'V2');
    await database`
      UPDATE brand_profiles SET status = 'published', published_at = now() WHERE id = ${first}
    `;
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    const request = {
      headers: { ...writeHeaders(strategy), 'if-match': '"2"' },
      method: 'POST' as const,
      payload: { version: 2 },
      url: `${API_PATH}/${second}/publish`,
    };
    const published = await requireServer(application).inject(request);
    const replay = await requireServer(application).inject(request);
    expect(published.statusCode).toBe(200);
    expect(published.json().data).toMatchObject({ id: second, status: 'published', version: 2 });
    expect(replay.statusCode).toBe(200);
    expect(
      await database<{ id: string; status: string }[]>`
        SELECT id, status FROM brand_profiles WHERE workspace_id = ${WORKSPACE_A} ORDER BY version
      `,
    ).toEqual([
      { id: first, status: 'retired' },
      { id: second, status: 'published' },
    ]);
    expect(
      await database<{ action: string }[]>`
        SELECT action FROM audit_events
        WHERE action IN ('brand_profile.published', 'brand_profile.retired')
        ORDER BY action
      `,
    ).toEqual([{ action: 'brand_profile.published' }, { action: 'brand_profile.retired' }]);

    const stale = await requireServer(application).inject({
      ...request,
      headers: { ...writeHeaders(strategy), 'if-match': '1' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');
  });

  it('retires only published versions with a reason and rejects missing preconditions', async () => {
    const database = requireClient(client);
    const publishedId = await insertProfile(
      database,
      TENANT_ID,
      WORKSPACE_A,
      OWNER_ID,
      1,
      'Published',
    );
    const draftId = await insertProfile(database, TENANT_ID, WORKSPACE_A, OWNER_ID, 2, 'Draft');
    await database`
      UPDATE brand_profiles SET status = 'published', published_at = now() WHERE id = ${publishedId}
    `;
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    const request = {
      headers: { ...writeHeaders(strategy), 'if-match': '1' },
      method: 'POST' as const,
      payload: { reason: 'Brand strategy has been replaced' },
      url: `${API_PATH}/${publishedId}/retire`,
    };
    const retired = await requireServer(application).inject(request);
    const replay = await requireServer(application).inject(request);
    expect(retired.statusCode).toBe(200);
    expect(retired.json().data.status).toBe('retired');
    expect(replay.statusCode).toBe(200);
    const audits = await database<{ after: { reason: string } }[]>`
      SELECT after_json AS after FROM audit_events WHERE action = 'brand_profile.retired'
    `;
    expect(audits).toHaveLength(1);
    expect(audits[0]?.after.reason).toBe('Brand strategy has been replaced');

    const draftRetire = await requireServer(application).inject({
      headers: { ...writeHeaders(strategy), 'if-match': '2' },
      method: 'POST',
      payload: { reason: 'Draft cannot be retired' },
      url: `${API_PATH}/${draftId}/retire`,
    });
    expect(draftRetire.statusCode).toBe(409);
    const missingVersion = await requireServer(application).inject({
      headers: writeHeaders(strategy),
      method: 'POST',
      payload: { reason: 'Missing precondition' },
      url: `${API_PATH}/${publishedId}/retire`,
    });
    expect(missingVersion.statusCode).toBe(422);
  });
});

function createPayload(workspaceId: string, positioning: string) {
  return { profile: profile(positioning), workspace_id: workspaceId };
}

function profile(positioning: string) {
  return {
    audience: ['Enterprise marketing leaders'],
    banned: ['guaranteed results'],
    compliance: ['Cite verified sources for factual claims'],
    cta: 'Request an evidence-led content assessment',
    differentiators: ['Traceable citations', 'Seven-platform workflow'],
    positioning,
    tone: 'Professional, direct, and evidence-led',
  };
}

async function insertProfile(
  database: Sql,
  tenantId: string,
  workspaceId: string,
  createdBy: string,
  version: number,
  positioning: string,
): Promise<string> {
  const rows = await database<{ id: string }[]>`
    INSERT INTO brand_profiles (
      tenant_id, workspace_id, version, schema_version, profile_json, created_by
    ) VALUES (
      ${tenantId}, ${workspaceId}, ${version}, 'brand-profile@1',
      ${JSON.stringify(profile(positioning))}::text::jsonb, ${createdBy}
    )
    RETURNING id
  `;
  const row = rows[0];
  if (!row) throw new Error('Expected brand profile fixture');
  return row.id;
}

async function createSession(
  database: Sql,
  userId: string,
  tenantId: string,
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

function readHeaders(tokens: { readonly session: string }) {
  return { cookie: `geo_session=${tokens.session}` };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireServer(application: NestFastifyApplication | undefined): FastifyInstance {
  if (!application) throw new Error('Brand profile test application was not initialized');
  return application.getHttpAdapter().getInstance();
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Brand profile PostgreSQL client was not initialized');
  return client;
}
