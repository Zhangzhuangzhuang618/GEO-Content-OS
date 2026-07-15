import {
  KeywordListResponseSchema,
  KeywordSetDetailResponseSchema,
  KeywordSetPageSchema,
  KeywordSetResponseSchema,
} from '@geo-content-os/contracts';
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

const OWNER_ID = '11000000-0000-4000-8000-000000000025';
const STRATEGY_ID = '11000000-0000-4000-8000-000000000125';
const SCOPED_ID = '11000000-0000-4000-8000-000000000225';
const CONTENT_ID = '11000000-0000-4000-8000-000000000325';
const OTHER_OWNER_ID = '11000000-0000-4000-8000-000000000425';
const TENANT_ID = '21000000-0000-4000-8000-000000000025';
const OTHER_TENANT_ID = '21000000-0000-4000-8000-000000000125';
const WORKSPACE_A = '31000000-0000-4000-8000-000000000025';
const WORKSPACE_B = '31000000-0000-4000-8000-000000000125';
const OTHER_WORKSPACE = '31000000-0000-4000-8000-000000000225';
const PROJECT_A = '41000000-0000-4000-8000-000000000025';
const PROJECT_B = '41000000-0000-4000-8000-000000000125';
const OTHER_PROJECT = '41000000-0000-4000-8000-000000000225';
const API_PATH = '/api/v1/keyword-sets';

describe('keyword API', () => {
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
        (${OWNER_ID}, 'keyword-owner@example.com', 'Keyword Owner', 'active'),
        (${STRATEGY_ID}, 'keyword-strategy@example.com', 'Keyword Strategy', 'active'),
        (${SCOPED_ID}, 'keyword-scoped@example.com', 'Keyword Scoped', 'active'),
        (${CONTENT_ID}, 'keyword-content@example.com', 'Keyword Content', 'active'),
        (${OTHER_OWNER_ID}, 'other-keyword-owner@example.com', 'Other Keyword Owner', 'active')
    `;
    await database`
      INSERT INTO tenants (id, name, slug, status)
      VALUES
        (${TENANT_ID}, 'Keyword Tenant', 'keyword-api-tenant', 'active'),
        (${OTHER_TENANT_ID}, 'Other Keyword Tenant', 'other-keyword-api-tenant', 'active')
    `;
    await database`
      INSERT INTO memberships (tenant_id, user_id, role_code, status)
      VALUES
        (${TENANT_ID}, ${OWNER_ID}, 'tenant_owner', 'active'),
        (${TENANT_ID}, ${STRATEGY_ID}, 'strategy_editor', 'active'),
        (${TENANT_ID}, ${SCOPED_ID}, 'strategy_editor', 'active'),
        (${TENANT_ID}, ${CONTENT_ID}, 'content_editor', 'active'),
        (${OTHER_TENANT_ID}, ${OTHER_OWNER_ID}, 'tenant_owner', 'active')
    `;
    await database`
      INSERT INTO workspaces (id, tenant_id, name, slug, timezone)
      VALUES
        (${WORKSPACE_A}, ${TENANT_ID}, 'Keyword Workspace A', 'keyword-a', 'UTC'),
        (${WORKSPACE_B}, ${TENANT_ID}, 'Keyword Workspace B', 'keyword-b', 'UTC'),
        (${OTHER_WORKSPACE}, ${OTHER_TENANT_ID}, 'Other Keyword Workspace', 'other-keyword', 'UTC')
    `;
    await database`
      INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id)
      VALUES
        (${PROJECT_A}, ${TENANT_ID}, ${WORKSPACE_A}, 'Keyword Project A', ${OWNER_ID}),
        (${PROJECT_B}, ${TENANT_ID}, ${WORKSPACE_B}, 'Keyword Project B', ${OWNER_ID}),
        (${OTHER_PROJECT}, ${OTHER_TENANT_ID}, ${OTHER_WORKSPACE}, 'Other Project', ${OTHER_OWNER_ID})
    `;
  });

  afterAll(async () => {
    await application?.close();
    await client?.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = originalDatabaseUrl;
  });

  it('creates an idempotent scoped keyword set and audits it', async () => {
    const database = requireClient(client);
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    const request = {
      headers: { ...writeHeaders(strategy), 'idempotency-key': 'keyword-set-create-001' },
      method: 'POST' as const,
      payload: { name: '  Core GEO keywords  ', project_id: PROJECT_A },
      url: API_PATH,
    };
    const created = await requireServer(application).inject(request);
    const replay = await requireServer(application).inject(request);
    expect(created.statusCode).toBe(201);
    expect(KeywordSetResponseSchema.safeParse(created.json()).success).toBe(true);
    expect(created.json().data).toMatchObject({
      name: 'Core GEO keywords',
      project_id: PROJECT_A,
      status: 'active',
      tenant_id: TENANT_ID,
    });
    expect(replay.json().data.id).toBe(created.json().data.id);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM keyword_sets WHERE project_id = ${PROJECT_A}
      `,
    ).toEqual([{ count: 1 }]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM audit_events WHERE action = 'keyword_set.created'
      `,
    ).toEqual([{ count: 1 }]);

    const idempotencyConflict = await requireServer(application).inject({
      ...request,
      payload: { name: 'Changed request body', project_id: PROJECT_A },
    });
    expect(idempotencyConflict.statusCode).toBe(409);
    expect(idempotencyConflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');

    const duplicate = await requireServer(application).inject({
      ...request,
      headers: { ...writeHeaders(strategy), 'idempotency-key': 'keyword-set-create-002' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('STATE_TRANSITION_INVALID');

    const missingKey = await requireServer(application).inject({
      ...request,
      headers: writeHeaders(strategy),
    });
    expect(missingKey.statusCode).toBe(422);
    const content = await createSession(database, CONTENT_ID, TENANT_ID);
    const forbidden = await requireServer(application).inject({
      ...request,
      headers: { ...writeHeaders(content), 'idempotency-key': 'keyword-set-create-003' },
    });
    expect(forbidden.statusCode).toBe(403);
    const forged = await requireServer(application).inject({
      ...request,
      headers: { ...writeHeaders(strategy), 'idempotency-key': 'keyword-set-create-004' },
      payload: { name: 'Forged tenant set', project_id: OTHER_PROJECT },
    });
    expect(forged.statusCode).toBe(404);
  });

  it('bulk upserts in input order, updates case-insensitively, disables, and replays safely', async () => {
    const database = requireClient(client);
    const keywordSetId = await insertKeywordSet(database, TENANT_ID, PROJECT_A, 'Bulk set');
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    const initialPayload = {
      keywords: [
        keyword('GEO content system', 'informational', 90, ['official_site', 'zhihu']),
        keyword('Enterprise content automation', 'commercial', 70, ['wechat_mp']),
      ],
    };
    const request = {
      headers: { ...writeHeaders(strategy), 'idempotency-key': 'keyword-upsert-001' },
      method: 'POST' as const,
      payload: initialPayload,
      url: `${API_PATH}/${keywordSetId}/keywords`,
    };
    const created = await requireServer(application).inject(request);
    const replay = await requireServer(application).inject(request);
    expect(created.statusCode).toBe(200);
    expect(KeywordListResponseSchema.safeParse(created.json()).success).toBe(true);
    expect(created.json().data.map((item: { term: string }) => item.term)).toEqual([
      'GEO content system',
      'Enterprise content automation',
    ]);
    expect(replay.json().data).toEqual(created.json().data);
    const originalId = created.json().data[0].id;

    const updated = await requireServer(application).inject({
      headers: { ...writeHeaders(strategy), 'idempotency-key': 'keyword-upsert-002' },
      method: 'POST',
      payload: {
        keywords: [
          {
            ...keyword('geo CONTENT system', 'transactional', 45, ['douyin']),
            status: 'disabled',
            synonyms: ['GEO production platform'],
          },
        ],
      },
      url: `${API_PATH}/${keywordSetId}/keywords`,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data[0]).toMatchObject({
      id: originalId,
      intent: 'transactional',
      platform_scope: ['douyin'],
      priority: 45,
      status: 'disabled',
      synonyms: ['GEO production platform'],
      term: 'geo CONTENT system',
    });
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM keywords WHERE keyword_set_id = ${keywordSetId}
      `,
    ).toEqual([{ count: 2 }]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM audit_events WHERE action = 'keywords.upserted'
      `,
    ).toEqual([{ count: 2 }]);
  });

  it('lists and reads only keyword sets in the active project scope', async () => {
    const database = requireClient(client);
    const setA = await insertKeywordSet(database, TENANT_ID, PROJECT_A, 'Visible set');
    await insertKeywordSet(database, TENANT_ID, PROJECT_B, 'Hidden set');
    const otherSet = await insertKeywordSet(
      database,
      OTHER_TENANT_ID,
      OTHER_PROJECT,
      'Other tenant set',
    );
    await database`
      INSERT INTO keywords (
        tenant_id, keyword_set_id, term, intent, priority, synonyms, platform_scope, status
      ) VALUES (
        ${TENANT_ID}, ${setA}, 'Scoped GEO', 'informational', 88,
        ARRAY['GEO scope'], ARRAY['official_site'], 'active'
      )
    `;
    await database`
      INSERT INTO workspace_memberships (workspace_id, user_id, scope_json)
      VALUES (
        ${WORKSPACE_A}, ${SCOPED_ID},
        ${JSON.stringify({ project_ids: [PROJECT_A], schema_version: 'workspace-scope@1' })}::text::jsonb
      )
    `;
    const scoped = await createSession(database, SCOPED_ID, TENANT_ID);
    const server = requireServer(application);

    const listed = await server.inject({
      headers: writeHeaders(scoped),
      method: 'GET',
      url: `${API_PATH}?project_id=${PROJECT_A}&status=active&limit=20`,
    });
    expect(listed.statusCode).toBe(200);
    expect(KeywordSetPageSchema.safeParse(listed.json()).success).toBe(true);
    expect(listed.json().data.map((item: { id: string }) => item.id)).toEqual([setA]);

    const detail = await server.inject({
      headers: writeHeaders(scoped),
      method: 'GET',
      url: `${API_PATH}/${setA}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(KeywordSetDetailResponseSchema.safeParse(detail.json()).success).toBe(true);
    expect(detail.json().data.keywords).toHaveLength(1);
    expect(detail.json().data.keywords[0]).toMatchObject({ priority: 88, term: 'Scoped GEO' });

    expect(
      (
        await server.inject({
          headers: writeHeaders(scoped),
          method: 'GET',
          url: `${API_PATH}/${otherSet}`,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('rejects invalid batches and enforces project scope and active parent state', async () => {
    const database = requireClient(client);
    const setA = await insertKeywordSet(database, TENANT_ID, PROJECT_A, 'Scoped A');
    const setB = await insertKeywordSet(database, TENANT_ID, PROJECT_B, 'Scoped B');
    const otherSet = await insertKeywordSet(database, OTHER_TENANT_ID, OTHER_PROJECT, 'Other set');
    await database`
      INSERT INTO workspace_memberships (workspace_id, user_id, scope_json)
      VALUES (
        ${WORKSPACE_A},
        ${SCOPED_ID},
        ${JSON.stringify({ project_ids: [PROJECT_A], schema_version: 'workspace-scope@1' })}::text::jsonb
      )
    `;
    const scoped = await createSession(database, SCOPED_ID, TENANT_ID);
    const post = async (id: string, payload: Record<string, unknown>, key: string) =>
      requireServer(application).inject({
        headers: { ...writeHeaders(scoped), 'idempotency-key': key },
        method: 'POST',
        payload,
        url: `${API_PATH}/${id}/keywords`,
      });

    expect(
      (await post(setA, { keywords: [keyword('Allowed')] }, 'keyword-scope-001')).statusCode,
    ).toBe(200);
    expect(
      (await post(setB, { keywords: [keyword('Hidden')] }, 'keyword-scope-002')).statusCode,
    ).toBe(404);
    expect(
      (await post(otherSet, { keywords: [keyword('Cross tenant')] }, 'keyword-scope-003'))
        .statusCode,
    ).toBe(404);

    const duplicateTerms = await post(
      setA,
      { keywords: [keyword('Duplicate term'), keyword('duplicate TERM')] },
      'keyword-invalid-001',
    );
    expect(duplicateTerms.statusCode).toBe(422);
    const invalidArrays = await post(
      setA,
      {
        keywords: [
          {
            ...keyword('Invalid arrays'),
            platform_scope: ['zhihu', 'zhihu'],
            synonyms: ['GEO', 'geo'],
          },
        ],
      },
      'keyword-invalid-002',
    );
    expect(invalidArrays.statusCode).toBe(422);
    await expect(
      database`
        INSERT INTO keywords (
          tenant_id, keyword_set_id, term, intent, synonyms, platform_scope
        ) VALUES (
          ${TENANT_ID}, ${setA}, 'Oversized synonym', 'informational',
          ARRAY[${'x'.repeat(241)}], ARRAY['official_site']
        )
      `,
    ).rejects.toThrow(/keywords_synonyms_check/u);
    await database`UPDATE keyword_sets SET status = 'archived', deleted_at = now() WHERE id = ${setA}`;
    expect(
      (await post(setA, { keywords: [keyword('Archived')] }, 'keyword-state-001')).statusCode,
    ).toBe(404);
  });

  it('serializes concurrent upserts without duplicate keyword rows', async () => {
    const database = requireClient(client);
    const keywordSetId = await insertKeywordSet(database, TENANT_ID, PROJECT_A, 'Concurrent set');
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    const server = requireServer(application);
    const [first, second] = await Promise.all([
      server.inject({
        headers: { ...writeHeaders(strategy), 'idempotency-key': 'keyword-concurrent-001' },
        method: 'POST',
        payload: { keywords: [keyword('Concurrent GEO', 'informational', 20)] },
        url: `${API_PATH}/${keywordSetId}/keywords`,
      }),
      server.inject({
        headers: { ...writeHeaders(strategy), 'idempotency-key': 'keyword-concurrent-002' },
        method: 'POST',
        payload: { keywords: [keyword('concurrent geo', 'commercial', 80)] },
        url: `${API_PATH}/${keywordSetId}/keywords`,
      }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM keywords WHERE keyword_set_id = ${keywordSetId}
      `,
    ).toEqual([{ count: 1 }]);
  });
});

function keyword(
  term: string,
  intent: 'informational' | 'commercial' | 'transactional' | 'navigational' = 'informational',
  priority = 50,
  platformScope: readonly string[] = ['official_site'],
) {
  return {
    intent,
    platform_scope: platformScope,
    priority,
    status: 'active',
    synonyms: [],
    term,
  };
}

async function insertKeywordSet(
  database: Sql,
  tenantId: string,
  projectId: string,
  name: string,
): Promise<string> {
  const rows = await database<{ id: string }[]>`
    INSERT INTO keyword_sets (tenant_id, project_id, name)
    VALUES (${tenantId}, ${projectId}, ${name})
    RETURNING id
  `;
  const row = rows[0];
  if (!row) throw new Error('Expected keyword set fixture');
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireServer(application: NestFastifyApplication | undefined): FastifyInstance {
  if (!application) throw new Error('Keyword test application was not initialized');
  return application.getHttpAdapter().getInstance();
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Keyword PostgreSQL client was not initialized');
  return client;
}
