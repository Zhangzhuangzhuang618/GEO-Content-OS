import {
  BatchKeywordOperationResponseSchema,
  KeywordImportJobResponseSchema,
  KeywordListResponseSchema,
  KeywordPageSchema,
  ProjectKeywordPlatformScopeSyncResponseSchema,
  KeywordSetDetailResponseSchema,
  KeywordSetPageSchema,
  KeywordSetResponseSchema,
} from '@geo-content-os/contracts';
import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import { KeywordImportWorker, PostgresKeywordImportStore } from '@geo-content-os/worker-knowledge';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import ExcelJS from 'exceljs';
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
        {
          ...keyword('GEO content system', 'informational', 90, ['official_site', 'zhihu']),
          intents: ['informational', 'commercial'],
        },
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
    expect(created.json().data[0].intents).toEqual(['informational', 'commercial']);
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
      intents: ['transactional'],
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

  it('batch updates, disables, and safely deletes only unreferenced keywords', async () => {
    const database = requireClient(client);
    const keywordSetId = await insertKeywordSet(database, TENANT_ID, PROJECT_A, 'Batch actions');
    const inserted = await database<{ id: string; term: string }[]>`
      INSERT INTO keywords (
        tenant_id, keyword_set_id, term, intent, intents, priority, synonyms, platform_scope, status
      ) VALUES
        (${TENANT_ID}, ${keywordSetId}, '批量关键词 A', 'commercial', ARRAY['commercial'], 30, '{}', ARRAY['official_site'], 'active'),
        (${TENANT_ID}, ${keywordSetId}, '批量关键词 B', 'commercial', ARRAY['commercial'], 40, '{}', ARRAY['official_site'], 'active'),
        (${TENANT_ID}, ${keywordSetId}, '批量关键词 C', 'commercial', ARRAY['commercial'], 50, '{}', ARRAY['official_site'], 'active')
      RETURNING id, term::text AS term
    `;
    const [first, second, third] = inserted;
    if (!first || !second || !third) throw new Error('Expected three keyword fixtures');
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    const updateRequest = {
      headers: { ...writeHeaders(strategy), 'idempotency-key': 'keyword-batch-update-001' },
      method: 'POST' as const,
      payload: {
        action: 'update',
        changes: {
          intents: ['informational', 'commercial'],
          platform_scope: ['lieju', 'sohu'],
          priority: 91,
        },
        keyword_ids: [first.id, second.id],
      },
      url: `${API_PATH}/${keywordSetId}/keywords/batch`,
    };
    const updated = await requireServer(application).inject(updateRequest);
    const replay = await requireServer(application).inject(updateRequest);
    expect(updated.statusCode).toBe(200);
    expect(BatchKeywordOperationResponseSchema.safeParse(updated.json()).success).toBe(true);
    expect(updated.json().data).toEqual({
      action: 'update',
      affected_count: 2,
      keyword_ids: [first.id, second.id],
      skipped_referenced_count: 0,
    });
    expect(replay.json()).toEqual(updated.json());
    expect(
      await database<
        { intents: string[]; platformScope: string[]; priority: number; term: string }[]
      >`
        SELECT term::text AS term, intents, priority, platform_scope AS "platformScope"
        FROM keywords
        WHERE id = ANY(${[first.id, second.id]}::uuid[])
        ORDER BY term
      `,
    ).toEqual([
      {
        intents: ['informational', 'commercial'],
        platformScope: ['lieju', 'sohu'],
        priority: 91,
        term: '批量关键词 A',
      },
      {
        intents: ['informational', 'commercial'],
        platformScope: ['lieju', 'sohu'],
        priority: 91,
        term: '批量关键词 B',
      },
    ]);

    const disabled = await requireServer(application).inject({
      headers: { ...writeHeaders(strategy), 'idempotency-key': 'keyword-batch-disable-001' },
      method: 'POST',
      payload: { action: 'disable', keyword_ids: [second.id] },
      url: `${API_PATH}/${keywordSetId}/keywords/batch`,
    });
    expect(disabled.statusCode).toBe(200);
    expect(
      await database<{ status: string }[]>`SELECT status FROM keywords WHERE id=${second.id}`,
    ).toEqual([{ status: 'disabled' }]);

    const briefs = await database<{ id: string }[]>`
      INSERT INTO briefs (
        tenant_id, workspace_id, project_id, title, objective, audience,
        platform_codes, constraints_json, created_by
      ) VALUES (
        ${TENANT_ID}, ${WORKSPACE_A}, ${PROJECT_A}, '已使用关键词的内容', 'education',
        '面向需要搬家服务的企业客户', ARRAY['official_site'],
        ${JSON.stringify({ schema_version: 'brief-constraints@1' })}::text::jsonb, ${OWNER_ID}
      )
      RETURNING id
    `;
    const brief = briefs[0];
    if (!brief) throw new Error('Expected brief fixture');
    await database`
      INSERT INTO brief_keywords (tenant_id, brief_id, keyword_id, is_primary)
      VALUES (${TENANT_ID}, ${brief.id}, ${first.id}, true)
    `;
    const protectedDelete = await requireServer(application).inject({
      headers: { ...writeHeaders(strategy), 'idempotency-key': 'keyword-batch-delete-001' },
      method: 'POST',
      payload: { action: 'delete', keyword_ids: [first.id, third.id] },
      url: `${API_PATH}/${keywordSetId}/keywords/batch`,
    });
    expect(protectedDelete.statusCode).toBe(200);
    expect(protectedDelete.json().data).toEqual({
      action: 'delete',
      affected_count: 1,
      keyword_ids: [first.id, third.id],
      skipped_referenced_count: 1,
    });
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM keywords WHERE id=${third.id}
      `,
    ).toEqual([{ count: 0 }]);

    const referencedOnlyDelete = await requireServer(application).inject({
      headers: { ...writeHeaders(strategy), 'idempotency-key': 'keyword-batch-delete-002' },
      method: 'POST',
      payload: { action: 'delete', keyword_ids: [first.id] },
      url: `${API_PATH}/${keywordSetId}/keywords/batch`,
    });
    expect(referencedOnlyDelete.statusCode).toBe(200);
    expect(referencedOnlyDelete.json().data).toEqual({
      action: 'delete',
      affected_count: 0,
      keyword_ids: [first.id],
      skipped_referenced_count: 1,
    });
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM keywords WHERE id=${first.id}
      `,
    ).toEqual([{ count: 1 }]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM audit_events
        WHERE action IN ('keywords.batch.update', 'keywords.batch.disable', 'keywords.batch.delete')
      `,
    ).toEqual([{ count: 4 }]);
  });

  it('applies filtered batch actions and skips only historically referenced deletes', async () => {
    const database = requireClient(client);
    const keywordSetId = await insertKeywordSet(
      database,
      TENANT_ID,
      PROJECT_A,
      'Filtered batch actions',
    );
    const inserted = await database<{ id: string; term: string }[]>`
      INSERT INTO keywords (
        tenant_id, keyword_set_id, term, intent, intents, priority, synonyms, platform_scope, status
      ) VALUES
        (${TENANT_ID}, ${keywordSetId}, '筛选列举关键词 A', 'commercial', ARRAY['commercial'], 30, '{}', ARRAY['lieju'], 'active'),
        (${TENANT_ID}, ${keywordSetId}, '筛选列举关键词 B', 'commercial', ARRAY['commercial'], 40, '{}', ARRAY['lieju','sohu'], 'active'),
        (${TENANT_ID}, ${keywordSetId}, '筛选搜狐关键词 C', 'commercial', ARRAY['commercial'], 50, '{}', ARRAY['sohu'], 'active'),
        (${TENANT_ID}, ${keywordSetId}, '筛选列举关键词 D', 'commercial', ARRAY['commercial'], 60, '{}', ARRAY['lieju'], 'disabled')
      RETURNING id, term::text AS term
    `;
    const [first] = inserted;
    if (!first) throw new Error('Expected filtered keyword fixtures');
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    const selection = {
      mode: 'all_filtered',
      platform_code: 'lieju',
      search: '筛选列举',
      status: 'active',
    };

    const updated = await requireServer(application).inject({
      headers: { ...writeHeaders(strategy), 'idempotency-key': 'keyword-filtered-update-001' },
      method: 'POST',
      payload: { action: 'update', changes: { priority: 88 }, selection },
      url: `${API_PATH}/${keywordSetId}/keywords/batch`,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data).toEqual({
      action: 'update',
      affected_count: 2,
      keyword_ids: null,
      skipped_referenced_count: 0,
    });
    expect(
      await database<{ priority: number; term: string }[]>`
        SELECT priority, term::text AS term
        FROM keywords
        WHERE keyword_set_id=${keywordSetId}
        ORDER BY term
      `,
    ).toEqual([
      { priority: 88, term: '筛选列举关键词 A' },
      { priority: 88, term: '筛选列举关键词 B' },
      { priority: 60, term: '筛选列举关键词 D' },
      { priority: 50, term: '筛选搜狐关键词 C' },
    ]);

    const briefs = await database<{ id: string }[]>`
      INSERT INTO briefs (
        tenant_id, workspace_id, project_id, title, objective, audience,
        platform_codes, constraints_json, created_by
      ) VALUES (
        ${TENANT_ID}, ${WORKSPACE_A}, ${PROJECT_A}, '筛选全选保护', 'education',
        '面向需要搬家服务的企业客户', ARRAY['lieju'],
        ${JSON.stringify({ schema_version: 'brief-constraints@1' })}::text::jsonb, ${OWNER_ID}
      )
      RETURNING id
    `;
    const brief = briefs[0];
    if (!brief) throw new Error('Expected filtered batch brief fixture');
    await database`
      INSERT INTO brief_keywords (tenant_id, brief_id, keyword_id, is_primary)
      VALUES (${TENANT_ID}, ${brief.id}, ${first.id}, true)
    `;
    const protectedDelete = await requireServer(application).inject({
      headers: { ...writeHeaders(strategy), 'idempotency-key': 'keyword-filtered-delete-001' },
      method: 'POST',
      payload: { action: 'delete', selection },
      url: `${API_PATH}/${keywordSetId}/keywords/batch`,
    });
    expect(protectedDelete.statusCode).toBe(200);
    expect(protectedDelete.json().data).toEqual({
      action: 'delete',
      affected_count: 1,
      keyword_ids: null,
      skipped_referenced_count: 1,
    });
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM keywords WHERE keyword_set_id=${keywordSetId}
      `,
    ).toEqual([{ count: 3 }]);

    const disabled = await requireServer(application).inject({
      headers: { ...writeHeaders(strategy), 'idempotency-key': 'keyword-filtered-disable-001' },
      method: 'POST',
      payload: { action: 'disable', selection },
      url: `${API_PATH}/${keywordSetId}/keywords/batch`,
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().data).toEqual({
      action: 'disable',
      affected_count: 1,
      keyword_ids: null,
      skipped_referenced_count: 0,
    });
    expect(
      await database<{ status: string; term: string }[]>`
        SELECT status, term::text AS term
        FROM keywords
        WHERE keyword_set_id=${keywordSetId}
        ORDER BY term
      `,
    ).toEqual([
      { status: 'disabled', term: '筛选列举关键词 A' },
      { status: 'disabled', term: '筛选列举关键词 D' },
      { status: 'active', term: '筛选搜狐关键词 C' },
    ]);
  });

  it('does not apply the 500 explicit-id limit to a server-resolved filtered selection', async () => {
    const database = requireClient(client);
    const keywordSetId = await insertKeywordSet(
      database,
      TENANT_ID,
      PROJECT_A,
      'Large filtered batch',
    );
    await database`
      INSERT INTO keywords (
        tenant_id, keyword_set_id, term, intent, intents, priority, synonyms, platform_scope, status
      )
      SELECT
        ${TENANT_ID},
        ${keywordSetId},
        '跨页全选关键词 ' || series.value,
        'commercial',
        ARRAY['commercial'],
        50,
        '{}',
        ARRAY['official_site'],
        'active'
      FROM generate_series(1, 501) AS series(value)
    `;
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    const disabled = await requireServer(application).inject({
      headers: { ...writeHeaders(strategy), 'idempotency-key': 'keyword-filtered-large-001' },
      method: 'POST',
      payload: {
        action: 'disable',
        selection: { mode: 'all_filtered', search: '跨页全选关键词', status: 'active' },
      },
      url: `${API_PATH}/${keywordSetId}/keywords/batch`,
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().data).toEqual({
      action: 'disable',
      affected_count: 501,
      keyword_ids: null,
      skipped_referenced_count: 0,
    });
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM keywords
        WHERE keyword_set_id=${keywordSetId} AND status='disabled'
      `,
    ).toEqual([{ count: 501 }]);
  });

  it('adds platform scope to every project keyword without activating disabled or archived data', async () => {
    const database = requireClient(client);
    const activeSet = await insertKeywordSet(database, TENANT_ID, PROJECT_A, 'Automation terms');
    const archivedSet = await insertKeywordSet(database, TENANT_ID, PROJECT_A, 'Archived terms');
    await database`UPDATE keyword_sets SET status='archived' WHERE id=${archivedSet}::uuid`;
    await database`
      INSERT INTO keywords (
        tenant_id,keyword_set_id,term,intent,intents,priority,platform_scope,status
      ) VALUES
        (${TENANT_ID},${activeSet},'Active automation term','commercial',ARRAY['commercial'],80,
          ARRAY['official_site'],'active'),
        (${TENANT_ID},${activeSet},'Disabled automation term','informational',ARRAY['informational'],50,
          ARRAY['official_site','sohu'],'disabled'),
        (${TENANT_ID},${archivedSet},'Archived automation term','informational',ARRAY['informational'],50,
          ARRAY['official_site'],'active')
    `;
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    const request = {
      headers: { ...writeHeaders(strategy), 'idempotency-key': 'keyword-platform-sync-001' },
      method: 'POST' as const,
      payload: { platform_codes: ['sohu', 'lieju'], project_id: PROJECT_A },
      url: `${API_PATH}/sync-platform-scope`,
    };
    const synced = await requireServer(application).inject(request);
    const replay = await requireServer(application).inject(request);
    expect(synced.statusCode).toBe(200);
    expect(ProjectKeywordPlatformScopeSyncResponseSchema.safeParse(synced.json()).success).toBe(
      true,
    );
    expect(synced.json().data).toEqual({
      active_keyword_count: 1,
      changed_count: 2,
      matched_count: 2,
      platform_codes: ['sohu', 'lieju'],
      project_id: PROJECT_A,
    });
    expect(replay.json()).toEqual(synced.json());
    expect(
      await database<{ platformScope: string[]; status: string; term: string }[]>`
        SELECT term::text AS term,platform_scope AS "platformScope",status
        FROM keywords ORDER BY term
      `,
    ).toEqual([
      {
        platformScope: ['official_site', 'sohu', 'lieju'],
        status: 'active',
        term: 'Active automation term',
      },
      {
        platformScope: ['official_site'],
        status: 'active',
        term: 'Archived automation term',
      },
      {
        platformScope: ['official_site', 'sohu', 'lieju'],
        status: 'disabled',
        term: 'Disabled automation term',
      },
    ]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM audit_events
        WHERE action='keywords.platform_scope.synced' AND resource_id=${PROJECT_A}::uuid
      `,
    ).toEqual([{ count: 1 }]);

    const noChange = await requireServer(application).inject({
      ...request,
      headers: { ...writeHeaders(strategy), 'idempotency-key': 'keyword-platform-sync-002' },
    });
    expect(noChange.json().data.changed_count).toBe(0);

    const content = await createSession(database, CONTENT_ID, TENANT_ID);
    const forbidden = await requireServer(application).inject({
      ...request,
      headers: { ...writeHeaders(content), 'idempotency-key': 'keyword-platform-sync-003' },
    });
    expect(forbidden.statusCode).toBe(403);
    const hidden = await requireServer(application).inject({
      ...request,
      headers: { ...writeHeaders(strategy), 'idempotency-key': 'keyword-platform-sync-004' },
      payload: { platform_codes: ['lieju'], project_id: OTHER_PROJECT },
    });
    expect(hidden.statusCode).toBe(404);
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
        tenant_id, keyword_set_id, term, intent, intents, priority, synonyms, platform_scope, status
      ) VALUES (
        ${TENANT_ID}, ${setA}, 'Scoped GEO', 'informational', ARRAY['informational','commercial'], 88,
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
    expect(detail.json().data.keywords[0]).toMatchObject({
      intents: ['informational', 'commercial'],
      priority: 88,
      term: 'Scoped GEO',
    });

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

  it('supports cursor compatibility plus page, platform, and priority filtering', async () => {
    const database = requireClient(client);
    const keywordSetId = await insertKeywordSet(database, TENANT_ID, PROJECT_A, 'Paged set');
    await database`
      INSERT INTO keywords (
        tenant_id, keyword_set_id, term, intent, intents, priority, synonyms, platform_scope, status
      ) VALUES
        (${TENANT_ID}, ${keywordSetId}, '关键词 A', 'commercial', ARRAY['commercial'], 90, '{}', ARRAY['official_site'], 'active'),
        (${TENANT_ID}, ${keywordSetId}, '关键词 B', 'commercial', ARRAY['commercial'], 80, '{}', ARRAY['official_site','lieju'], 'active'),
        (${TENANT_ID}, ${keywordSetId}, '关键词 C', 'informational', ARRAY['informational'], 70, '{}', ARRAY['lieju'], 'disabled'),
        (${TENANT_ID}, ${keywordSetId}, '关键词 D', 'informational', ARRAY['informational'], 60, '{}', ARRAY['lieju'], 'active')
    `;
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    const server = requireServer(application);
    const first = await server.inject({
      headers: writeHeaders(strategy),
      method: 'GET',
      url: `${API_PATH}/${keywordSetId}/keywords?limit=1&status=active`,
    });
    expect(first.statusCode).toBe(200);
    expect(KeywordPageSchema.safeParse(first.json()).success).toBe(true);
    expect(first.json().data.map((item: { term: string }) => item.term)).toEqual(['关键词 A']);
    const second = await server.inject({
      headers: writeHeaders(strategy),
      method: 'GET',
      url: `${API_PATH}/${keywordSetId}/keywords?limit=1&status=active&cursor=${encodeURIComponent(first.json().meta.next_cursor)}`,
    });
    expect(second.json().data.map((item: { term: string }) => item.term)).toEqual(['关键词 B']);
    expect(second.json().meta.next_cursor).not.toBeNull();

    const paged = await server.inject({
      headers: writeHeaders(strategy),
      method: 'GET',
      url: `${API_PATH}/${keywordSetId}/keywords?limit=1&page=2&status=active&platform_code=lieju&sort=priority_asc`,
    });
    expect(paged.statusCode).toBe(200);
    expect(KeywordPageSchema.safeParse(paged.json()).success).toBe(true);
    expect(paged.json().data.map((item: { term: string }) => item.term)).toEqual(['关键词 B']);
    expect(paged.json().meta).toMatchObject({
      page: 2,
      page_size: 1,
      total_count: 2,
      total_pages: 2,
    });
  });

  it('preflights an XLSX upload idempotently and stages clustered candidates', async () => {
    const database = requireClient(client);
    const keywordSetId = await insertKeywordSet(database, TENANT_ID, PROJECT_A, 'Preflight set');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('关键词库');
    sheet.addRow([
      '关键词',
      '地域',
      '服务类型',
      '搜索意图',
      '场景',
      '修饰词/路线',
      '建议页面类型',
      '生成来源',
    ]);
    sheet.addRow([
      '广州荔湾附近搬家',
      '广州荔湾',
      '搬家',
      '本地搜索',
      '居民搬家',
      '附近',
      '服务页',
      '地域×服务×修饰词',
    ]);
    sheet.addRow([
      '广州荔湾搬家附近',
      '广州荔湾',
      '搬家',
      '本地搜索',
      '居民搬家',
      '附近',
      '服务页',
      '地域×服务×修饰词',
    ]);
    const boundary = 'keyword-import-integration-boundary';
    const payload = multipartKeywordWorkbook(
      Buffer.from(await workbook.xlsx.writeBuffer()),
      boundary,
    );
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    const request = {
      headers: {
        ...writeHeaders(strategy),
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'idempotency-key': 'keyword-import-preflight-001',
      },
      method: 'POST' as const,
      payload,
      url: `${API_PATH}/${keywordSetId}/imports/preflight`,
    };
    const created = await requireServer(application).inject(request);
    const replay = await requireServer(application).inject(request);
    expect(created.statusCode).toBe(201);
    expect(KeywordImportJobResponseSchema.safeParse(created.json()).success).toBe(true);
    expect(created.json().data).toMatchObject({
      candidate_count: 1,
      folded_row_count: 1,
      invalid_row_count: 0,
      status: 'preflight_ready',
      total_row_count: 2,
    });
    expect(replay.json().data.id).toBe(created.json().data.id);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM keyword_import_candidates
        WHERE import_job_id = ${created.json().data.id}
      `,
    ).toEqual([{ count: 1 }]);
  });

  it('queues and processes a staged keyword import with durable progress', async () => {
    const database = requireClient(client);
    const keywordSetId = await insertKeywordSet(database, TENANT_ID, PROJECT_A, 'Import set');
    const importJobId = '51000000-0000-4000-8000-000000000025';
    const summary = {
      candidate_samples: [
        {
          intents: ['commercial', 'transactional'],
          source_intent: '本地搜索',
          suggested_page_type: '服务页',
          synonyms: ['广州荔湾搬家附近'],
          term: '广州荔湾附近搬家',
        },
      ],
      page_types: [{ count: 1, label: '服务页' }],
      source_intents: [{ count: 1, label: '本地搜索' }],
    };
    await database`
      INSERT INTO keyword_import_jobs (
        id, tenant_id, keyword_set_id, file_name, content_hash, sheet_name, header_row,
        total_row_count, candidate_count, folded_row_count, invalid_row_count, summary_json, created_by
      ) VALUES (
        ${importJobId}, ${TENANT_ID}, ${keywordSetId}, '广州搬家关键词库.xlsx', ${'a'.repeat(64)},
        '关键词库', 4, 2, 1, 1, 0, ${JSON.stringify(summary)}::text::jsonb, ${STRATEGY_ID}
      )
    `;
    await database`
      INSERT INTO keyword_import_candidates (
        tenant_id, import_job_id, row_number, term, intents, synonyms, source_intent,
        suggested_page_type, cluster_key, metadata_json
      ) VALUES (
        ${TENANT_ID}, ${importJobId}, 5, '广州荔湾附近搬家', ARRAY['commercial','transactional'],
        ARRAY['广州荔湾搬家附近'], '本地搜索', '服务页', ${'b'.repeat(64)},
        ${JSON.stringify({
          generation_source: '地域×服务×修饰词',
          modifier_route: '附近',
          region: '广州荔湾',
          scene: '居民搬家',
          schema_version: 'keyword-import-metadata@1',
          service_type: '搬家',
          source_intent: '本地搜索',
          source_row: 5,
          source_sheet: '关键词库',
          suggested_page_type: '服务页',
        })}::text::jsonb
      )
    `;
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    const queued = await requireServer(application).inject({
      headers: { ...writeHeaders(strategy), 'idempotency-key': 'keyword-import-commit-001' },
      method: 'POST',
      payload: {
        platform_scope: ['official_site'],
        priority: 50,
        selected_page_types: ['服务页'],
        selected_source_intents: ['本地搜索'],
        status: 'disabled',
      },
      url: `${API_PATH}/${keywordSetId}/imports/${importJobId}/commit`,
    });
    expect(queued.statusCode).toBe(202);
    expect(KeywordImportJobResponseSchema.safeParse(queued.json()).success).toBe(true);
    expect(queued.json().data).toMatchObject({ selected_count: 1, status: 'queued' });

    const progress = await requireServer(application).inject({
      headers: writeHeaders(strategy),
      method: 'GET',
      url: `${API_PATH}/${keywordSetId}/imports/${importJobId}`,
    });
    expect(progress.statusCode).toBe(200);
    expect(progress.json().data.status).toBe('queued');
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM outbox_events
        WHERE aggregate_id = ${importJobId}
          AND event_type = 'strategy.keyword_import.requested.v1'
      `,
    ).toEqual([{ count: 1 }]);

    const worker = new KeywordImportWorker(new PostgresKeywordImportStore(database), 1);
    await expect(
      worker.run({
        aggregate: { id: importJobId, type: 'keyword_import_job' },
        data: { import_job_id: importJobId, keyword_set_id: keywordSetId },
        event_id: '61000000-0000-4000-8000-000000000025',
        event_type: 'strategy.keyword_import.requested.v1',
        occurred_at: '2026-08-03T00:00:00.000Z',
        tenant: { id: TENANT_ID },
      }),
    ).resolves.toMatchObject({ disposition: 'processed', importJobId });
    await expect(
      worker.run({
        aggregate: { id: importJobId, type: 'keyword_import_job' },
        data: { import_job_id: importJobId, keyword_set_id: keywordSetId },
        event_id: '61000000-0000-4000-8000-000000000026',
        event_type: 'strategy.keyword_import.requested.v1',
        occurred_at: '2026-08-03T00:00:01.000Z',
        tenant: { id: TENANT_ID },
      }),
    ).resolves.toMatchObject({ disposition: 'already_processed' });
    expect(
      await database<
        { importedCount: number; status: string }[]
      >`SELECT status, imported_count AS "importedCount" FROM keyword_import_jobs WHERE id = ${importJobId}`,
    ).toEqual([{ importedCount: 1, status: 'succeeded' }]);
    expect(
      await database<
        { sourceImportJobId: string; status: string; term: string }[]
      >`SELECT term::text AS term, status, source_import_job_id AS "sourceImportJobId" FROM keywords WHERE keyword_set_id = ${keywordSetId}`,
    ).toEqual([{ sourceImportJobId: importJobId, status: 'disabled', term: '广州荔湾附近搬家' }]);
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
          tenant_id, keyword_set_id, term, intent, intents, synonyms, platform_scope
        ) VALUES (
          ${TENANT_ID}, ${setA}, 'Oversized synonym', 'informational', ARRAY['informational'],
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
    intents: [intent],
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

function multipartKeywordWorkbook(body: Buffer, boundary: string): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="sheet_name"\r\n\r\n关键词库\r\n`,
      'utf8',
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="keywords.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`,
      'utf8',
    ),
    body,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);
}

function requireServer(application: NestFastifyApplication | undefined): FastifyInstance {
  if (!application) throw new Error('Keyword test application was not initialized');
  return application.getHttpAdapter().getInstance();
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Keyword PostgreSQL client was not initialized');
  return client;
}
