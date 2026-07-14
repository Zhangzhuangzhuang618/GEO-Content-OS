import { BriefPageSchema, BriefResponseSchema } from '@geo-content-os/contracts';
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
import { BriefService } from '../../src/modules/content/index.js';

const OWNER_ID = '13000000-0000-4000-8000-000000000044';
const STRATEGY_ID = '13000000-0000-4000-8000-000000000144';
const CONTENT_ID = '13000000-0000-4000-8000-000000000244';
const VIEWER_ID = '13000000-0000-4000-8000-000000000344';
const OTHER_OWNER_ID = '13000000-0000-4000-8000-000000000444';
const TENANT_ID = '23000000-0000-4000-8000-000000000044';
const OTHER_TENANT_ID = '23000000-0000-4000-8000-000000000144';
const WORKSPACE_A = '33000000-0000-4000-8000-000000000044';
const WORKSPACE_B = '33000000-0000-4000-8000-000000000144';
const OTHER_WORKSPACE = '33000000-0000-4000-8000-000000000244';
const PROJECT_A = '43000000-0000-4000-8000-000000000044';
const PROJECT_B = '43000000-0000-4000-8000-000000000144';
const OTHER_PROJECT = '43000000-0000-4000-8000-000000000244';
const KEYWORD_SET_A = '53000000-0000-4000-8000-000000000044';
const KEYWORD_SET_B = '53000000-0000-4000-8000-000000000144';
const KEYWORD_A = '63000000-0000-4000-8000-000000000044';
const KEYWORD_A2 = '63000000-0000-4000-8000-000000000144';
const KEYWORD_B = '63000000-0000-4000-8000-000000000244';
const SOURCE_A = '73000000-0000-4000-8000-000000000044';
const SOURCE_A2 = '73000000-0000-4000-8000-000000000144';
const SOURCE_B = '73000000-0000-4000-8000-000000000244';
const SOURCE_INACTIVE = '73000000-0000-4000-8000-000000000344';
const BRIEF_PATH = '/api/v1/briefs';

describe('Brief API', () => {
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
    await database`TRUNCATE ai_citations, content_block_locks, content_blocks, content_versions, content_variants, content_packages, fact_sources, facts, embeddings, source_chunks, ingest_jobs, brief_sources, brief_keywords, briefs, source_documents, topic_candidates, generation_runs, keywords, keyword_sets, brand_profiles, workspace_memberships, projects, workspaces, audit_events, outbox_events, support_access_grants, idempotency_records, password_reset_tokens, invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
    await database`
      INSERT INTO users (id, email, display_name, status)
      VALUES
        (${OWNER_ID}, 'brief-owner@example.com', 'Brief Owner', 'active'),
        (${STRATEGY_ID}, 'brief-strategy@example.com', 'Brief Strategy', 'active'),
        (${CONTENT_ID}, 'brief-content@example.com', 'Brief Content', 'active'),
        (${VIEWER_ID}, 'brief-viewer@example.com', 'Brief Viewer', 'active'),
        (${OTHER_OWNER_ID}, 'brief-other@example.com', 'Brief Other', 'active')
    `;
    await database`
      INSERT INTO tenants (id, name, slug, status)
      VALUES
        (${TENANT_ID}, 'Brief Tenant', 'brief-tenant', 'active'),
        (${OTHER_TENANT_ID}, 'Other Brief Tenant', 'other-brief-tenant', 'active')
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
        (${WORKSPACE_A}, ${TENANT_ID}, 'Brief Workspace A', 'brief-a', 'UTC'),
        (${WORKSPACE_B}, ${TENANT_ID}, 'Brief Workspace B', 'brief-b', 'UTC'),
        (${OTHER_WORKSPACE}, ${OTHER_TENANT_ID}, 'Other Workspace', 'brief-other', 'UTC')
    `;
    await database`
      INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id)
      VALUES
        (${PROJECT_A}, ${TENANT_ID}, ${WORKSPACE_A}, 'Brief Project A', ${OWNER_ID}),
        (${PROJECT_B}, ${TENANT_ID}, ${WORKSPACE_B}, 'Brief Project B', ${OWNER_ID}),
        (${OTHER_PROJECT}, ${OTHER_TENANT_ID}, ${OTHER_WORKSPACE}, 'Other Project', ${OTHER_OWNER_ID})
    `;
    await database`
      INSERT INTO workspace_memberships (workspace_id, user_id, scope_json)
      VALUES (
        ${WORKSPACE_A},
        ${VIEWER_ID},
        ${JSON.stringify({ project_ids: [PROJECT_A], schema_version: 'workspace-scope@1' })}::text::jsonb
      )
    `;
    await database`
      INSERT INTO keyword_sets (id, tenant_id, project_id, name)
      VALUES
        (${KEYWORD_SET_A}, ${TENANT_ID}, ${PROJECT_A}, 'Brief Keywords A'),
        (${KEYWORD_SET_B}, ${TENANT_ID}, ${PROJECT_B}, 'Brief Keywords B')
    `;
    await database`
      INSERT INTO keywords (
        id, tenant_id, keyword_set_id, term, intent, priority, platform_scope, status
      ) VALUES
        (${KEYWORD_A}, ${TENANT_ID}, ${KEYWORD_SET_A}, 'Enterprise GEO', 'informational', 90, ARRAY['official_site','zhihu'], 'active'),
        (${KEYWORD_A2}, ${TENANT_ID}, ${KEYWORD_SET_A}, 'GEO evidence', 'informational', 80, ARRAY['official_site','zhihu','douyin'], 'active'),
        (${KEYWORD_B}, ${TENANT_ID}, ${KEYWORD_SET_B}, 'Wrong project GEO', 'commercial', 70, ARRAY['official_site'], 'active')
    `;
    await database`
      INSERT INTO source_documents (
        id, tenant_id, workspace_id, project_id, title, source_type, mime_type,
        uri, content_hash, trust_level, status, created_by
      ) VALUES
        (${SOURCE_A}, ${TENANT_ID}, ${WORKSPACE_A}, ${PROJECT_A}, 'Evidence A', 'txt', 'text/plain', 'memory://brief-a', ${'a'.repeat(64)}, 'verified', 'active', ${OWNER_ID}),
        (${SOURCE_A2}, ${TENANT_ID}, ${WORKSPACE_A}, NULL, 'Shared evidence', 'txt', 'text/plain', 'memory://brief-shared', ${'b'.repeat(64)}, 'normal', 'active', ${OWNER_ID}),
        (${SOURCE_B}, ${TENANT_ID}, ${WORKSPACE_B}, ${PROJECT_B}, 'Wrong source', 'txt', 'text/plain', 'memory://brief-b', ${'c'.repeat(64)}, 'verified', 'active', ${OWNER_ID}),
        (${SOURCE_INACTIVE}, ${TENANT_ID}, ${WORKSPACE_A}, ${PROJECT_A}, 'Inactive source', 'txt', 'text/plain', 'memory://brief-inactive', ${'d'.repeat(64)}, 'normal', 'failed', ${OWNER_ID})
    `;
  });

  afterAll(async () => {
    await application?.close();
    await client?.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = originalDatabaseUrl;
  });

  it('creates one idempotent Brief with keyword/source links, audit, and cost workload input', async () => {
    const database = requireClient(client);
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    const request = createBriefRequest(strategy, 'brief-create-001');
    const first = await requireServer(application).inject(request);
    const replay = await requireServer(application).inject(request);
    expect(first.statusCode).toBe(201);
    expect(first.headers.etag).toBe('"1"');
    expect(BriefResponseSchema.safeParse(first.json()).success).toBe(true);
    expect(replay.json().data.id).toBe(first.json().data.id);
    const briefId = first.json().data.id as string;
    expect(
      await database<{ keywordId: string; primary: boolean }[]>`
        SELECT keyword_id AS "keywordId", is_primary AS primary
        FROM brief_keywords WHERE brief_id = ${briefId} ORDER BY is_primary DESC, keyword_id
      `,
    ).toEqual([
      { keywordId: KEYWORD_A, primary: true },
      { keywordId: KEYWORD_A2, primary: false },
    ]);
    expect(
      await database<{ required: boolean; sourceId: string }[]>`
        SELECT source_document_id AS "sourceId", required
        FROM brief_sources WHERE brief_id = ${briefId} ORDER BY source_document_id
      `,
    ).toEqual([
      { required: true, sourceId: SOURCE_A },
      { required: true, sourceId: SOURCE_A2 },
    ]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM audit_events WHERE action = 'brief.created'
      `,
    ).toEqual([{ count: 1 }]);
    const estimate = await requireBriefService(application).estimateCost(
      TENANT_ID,
      STRATEGY_ID,
      briefId,
    );
    expect(estimate).toMatchObject({
      generation_request_count: 3,
      platform_codes: ['official_site', 'zhihu'],
      pricing_status: 'requires_model_router',
      schema_version: 'brief-cost-estimate-input@1',
    });
    expect(estimate.estimated_input_tokens).toBeGreaterThan(1_000);
    expect(estimate.estimated_output_tokens).toBeGreaterThan(5_000);
  });

  it('serves scoped, filtered, stable cursor pages and non-enumerating detail reads', async () => {
    const database = requireClient(client);
    const owner = await createSession(database, OWNER_ID, TENANT_ID);
    const viewer = await createSession(database, VIEWER_ID, TENANT_ID);
    const first = await requireServer(application).inject(
      createBriefRequest(owner, 'brief-create-002', { title: 'Alpha GEO evidence' }),
    );
    await requireServer(application).inject(
      createBriefRequest(owner, 'brief-create-003', {
        objective: 'awareness',
        source_ids: [],
        title: 'Beta GEO campaign',
      }),
    );
    const firstPage = await requireServer(application).inject({
      headers: readHeaders(viewer),
      method: 'GET',
      url: `${BRIEF_PATH}?workspace_id=${WORKSPACE_A}&search=GEO&limit=1`,
    });
    expect(firstPage.statusCode).toBe(200);
    expect(BriefPageSchema.safeParse(firstPage.json()).success).toBe(true);
    expect(firstPage.json().data).toHaveLength(1);
    expect(firstPage.json().meta.next_cursor).toBeTypeOf('string');
    const secondPage = await requireServer(application).inject({
      headers: readHeaders(viewer),
      method: 'GET',
      url: `${BRIEF_PATH}?workspace_id=${WORKSPACE_A}&search=GEO&limit=1&cursor=${encodeURIComponent(firstPage.json().meta.next_cursor as string)}`,
    });
    expect(secondPage.json().data).toHaveLength(1);
    expect(secondPage.json().data[0].id).not.toBe(firstPage.json().data[0].id);
    expect(secondPage.json().meta.next_cursor).toBeNull();
    const detail = await requireServer(application).inject({
      headers: readHeaders(viewer),
      method: 'GET',
      url: `${BRIEF_PATH}/${first.json().data.id as string}`,
    });
    expect(detail.statusCode).toBe(200);

    await database`
      UPDATE workspace_memberships
      SET scope_json = ${JSON.stringify({ project_ids: [], schema_version: 'workspace-scope@1' })}::text::jsonb
      WHERE workspace_id = ${WORKSPACE_A} AND user_id = ${VIEWER_ID}
    `;
    expect(
      (
        await requireServer(application).inject({
          headers: readHeaders(viewer),
          method: 'GET',
          url: `${BRIEF_PATH}/${first.json().data.id as string}`,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('atomically updates fields and associations with strong version and idempotency guards', async () => {
    const database = requireClient(client);
    const content = await createSession(database, CONTENT_ID, TENANT_ID);
    const created = await requireServer(application).inject(
      createBriefRequest(content, 'brief-create-004'),
    );
    const briefId = created.json().data.id as string;
    const update = {
      headers: {
        ...writeHeaders(content),
        'idempotency-key': 'brief-update-001',
        'if-match': '"1"',
      },
      method: 'PATCH' as const,
      payload: {
        audience: 'Enterprise GEO leaders who require verified operational guidance',
        keyword_ids: [KEYWORD_A2],
        primary_keyword_id: KEYWORD_A2,
        source_ids: [SOURCE_A2],
        title: 'Updated enterprise GEO evidence plan',
      },
      url: `${BRIEF_PATH}/${briefId}`,
    };
    const first = await requireServer(application).inject(update);
    const replay = await requireServer(application).inject(update);
    expect(first.statusCode).toBe(200);
    expect(first.headers.etag).toBe('"2"');
    expect(replay.json().data).toEqual(first.json().data);
    expect(first.json().data).toMatchObject({
      keyword_ids: [KEYWORD_A2],
      primary_keyword_id: KEYWORD_A2,
      source_ids: [SOURCE_A2],
      version: 2,
    });
    const stale = {
      ...update,
      headers: { ...update.headers, 'idempotency-key': 'brief-update-002' },
    };
    expect((await requireServer(application).inject(stale)).statusCode).toBe(409);
    expect(
      await database<{ action: string }[]>`
        SELECT action FROM audit_events WHERE resource_id = ${briefId} ORDER BY created_at
      `,
    ).toEqual([{ action: 'brief.created' }, { action: 'brief.updated' }]);
  });

  it('rejects missing factual evidence and cross-project, inactive, or platform-incompatible inputs', async () => {
    const database = requireClient(client);
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    const noEvidence = createBriefRequest(strategy, 'brief-invalid-001', { source_ids: [] });
    expect((await requireServer(application).inject(noEvidence)).statusCode).toBe(422);

    const wrongKeyword = createBriefRequest(strategy, 'brief-invalid-002', {
      keyword_ids: [KEYWORD_B],
      primary_keyword_id: KEYWORD_B,
    });
    expect((await requireServer(application).inject(wrongKeyword)).statusCode).toBe(409);

    const wrongSource = createBriefRequest(strategy, 'brief-invalid-003', {
      source_ids: [SOURCE_B],
    });
    expect((await requireServer(application).inject(wrongSource)).statusCode).toBe(409);

    const inactiveSource = createBriefRequest(strategy, 'brief-invalid-004', {
      source_ids: [SOURCE_INACTIVE],
    });
    expect((await requireServer(application).inject(inactiveSource)).statusCode).toBe(409);

    const incompatiblePlatform = createBriefRequest(strategy, 'brief-invalid-005', {
      platform_codes: ['douyin'],
    });
    expect((await requireServer(application).inject(incompatiblePlatform)).statusCode).toBe(409);
    expect(
      await database<{ count: number }[]>`SELECT count(*)::integer AS count FROM briefs`,
    ).toEqual([{ count: 0 }]);
  });

  it('allows tenant members to read while enforcing Brief write permissions and strict DTOs', async () => {
    const database = requireClient(client);
    const viewer = await createSession(database, VIEWER_ID, TENANT_ID);
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    expect(
      (await requireServer(application).inject(createBriefRequest(viewer, 'brief-forbidden-001')))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await requireServer(application).inject({
          headers: readHeaders(viewer),
          method: 'GET',
          url: BRIEF_PATH,
        })
      ).statusCode,
    ).toBe(200);
    const malformed = createBriefRequest(strategy, 'brief-malformed-001');
    Object.assign(malformed.payload, { unknown_field: true });
    expect((await requireServer(application).inject(malformed)).statusCode).toBe(422);
  });
});

function createBriefRequest(
  tokens: { readonly csrf: string; readonly session: string },
  key: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    headers: { ...writeHeaders(tokens), 'idempotency-key': key },
    method: 'POST' as const,
    payload: {
      audience: 'Enterprise marketing and content operations leaders',
      constraints: { cta: 'Request an enterprise GEO assessment' },
      due_at: null,
      keyword_ids: [KEYWORD_A, KEYWORD_A2],
      objective: 'education',
      platform_codes: ['official_site', 'zhihu'],
      primary_keyword_id: KEYWORD_A,
      project_id: PROJECT_A,
      source_ids: [SOURCE_A, SOURCE_A2],
      title: 'Enterprise GEO evidence operating plan',
      workspace_id: WORKSPACE_A,
      ...overrides,
    },
    url: BRIEF_PATH,
  };
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

function requireBriefService(application: NestFastifyApplication | undefined): BriefService {
  if (!application) throw new Error('Brief test application was not initialized');
  return application.get(BriefService);
}

function requireServer(application: NestFastifyApplication | undefined): FastifyInstance {
  if (!application) throw new Error('Brief test application was not initialized');
  return application.getHttpAdapter().getInstance();
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Brief PostgreSQL client was not initialized');
  return client;
}
