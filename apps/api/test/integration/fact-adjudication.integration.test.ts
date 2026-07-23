import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApplication } from '../../src/application.js';
import { migrateDatabase } from '../../src/database/migrate.js';
import {
  FactAdjudicationNotFoundError,
  FactAdjudicationService,
} from '../../src/modules/knowledge/index.js';

const REVIEWER = '19000000-0000-4000-8000-000000000039';
const ADMIN = '19000000-0000-4000-8000-000000000139';
const VIEWER = '19000000-0000-4000-8000-000000000239';
const OTHER_OWNER = '19000000-0000-4000-8000-000000000339';
const TENANT = '29000000-0000-4000-8000-000000000039';
const OTHER_TENANT = '29000000-0000-4000-8000-000000000139';
const WORKSPACE_A = '39000000-0000-4000-8000-000000000039';
const WORKSPACE_B = '39000000-0000-4000-8000-000000000139';
const OTHER_WORKSPACE = '39000000-0000-4000-8000-000000000239';
const SOURCE_A = '59000000-0000-4000-8000-000000000039';
const SOURCE_B = '59000000-0000-4000-8000-000000000139';
const SOURCE_PROCESSING = '59000000-0000-4000-8000-000000000239';
const SOURCE_UNTRUSTED = '59000000-0000-4000-8000-000000000339';
const OTHER_SOURCE = '59000000-0000-4000-8000-000000000439';
const API_PATH = '/api/v1/facts';
const SOURCE_A_TEXT =
  '星云系统上市时间包括2025年9月和2025年10月，首发价格为9999元，渠道价格为8999元。';
const SOURCE_B_TEXT = '北辰系统发布日期为2026年1月。';

describe('fact adjudication API', () => {
  let application: NestFastifyApplication | undefined;
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  let originalDatabaseUrl: string | undefined;
  let originalNodeEnvironment: string | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 8 });
    originalDatabaseUrl = process.env['DATABASE_URL'];
    originalNodeEnvironment = process.env['NODE_ENV'];
    process.env['DATABASE_URL'] = container.getConnectionUri();
    process.env['NODE_ENV'] = 'test';
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
    await database`TRUNCATE fact_sources, facts, embeddings, source_chunks, ingest_jobs, brief_sources, brief_keywords, briefs, source_documents, topic_candidates, generation_runs, keywords, keyword_sets, brand_profiles, workspace_memberships, projects, workspaces, audit_events, outbox_events, support_access_grants, idempotency_records, password_reset_tokens, invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
    await seed(database);
  });

  afterAll(async () => {
    await application?.close();
    await client?.end();
    await container?.stop();
    restoreEnvironment('DATABASE_URL', originalDatabaseUrl);
    restoreEnvironment('NODE_ENV', originalNodeEnvironment);
  });

  it('verifies a grounded candidate and atomically records immutable before/after audit history', async () => {
    const database = requireClient(client);
    const fact = await insertFact(database, {
      objectValue: '2025年9月',
      sourceDocumentId: SOURCE_A,
      workspaceId: WORKSPACE_A,
    });
    const tokens = await createSession(database, REVIEWER, TENANT);
    const response = await adjudicate(application, tokens, fact, 'verified', '已核对原始资料');

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({
      confidence: 0.8,
      id: fact.id,
      object_value: '2025年9月',
      status: 'verified',
      tenant_id: TENANT,
      workspace_id: WORKSPACE_A,
    });
    expect(response.headers.etag).toBe(`"${response.json().data.updated_at}"`);
    expect(response.json().data.updated_at).not.toBe(fact.updatedAt);
    const audits = await database<
      {
        action: string;
        actorId: string;
        after: { reason: string; status: string };
        before: { status: string };
        requestId: string;
        resourceType: string;
      }[]
    >`
      SELECT
        action,
        actor_id AS "actorId",
        before_json AS before,
        after_json AS after,
        request_id AS "requestId",
        resource_type AS "resourceType"
      FROM audit_events
      WHERE resource_id = ${fact.id}::uuid
    `;
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'knowledge.fact.verified',
        actorId: REVIEWER,
        after: expect.objectContaining({ reason: '已核对原始资料', status: 'verified' }),
        before: expect.objectContaining({ status: 'candidate' }),
        requestId: expect.any(String),
        resourceType: 'fact',
      }),
    ]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM fact_sources WHERE fact_id = ${fact.id}::uuid
      `,
    ).toEqual([{ count: 1 }]);
  });

  it('supports evidence-backed conflict and retirement decisions while keeping retired facts terminal', async () => {
    const database = requireClient(client);
    const fact = await insertFact(database, {
      objectValue: '2025年9月',
      sourceDocumentId: SOURCE_A,
      workspaceId: WORKSPACE_A,
    });
    await insertFact(database, {
      objectValue: '2025年10月',
      sourceDocumentId: SOURCE_A,
      workspaceId: WORKSPACE_A,
    });
    const tokens = await createSession(database, ADMIN, TENANT);

    const conflicted = await adjudicate(
      application,
      tokens,
      fact,
      'conflicted',
      '同一谓词存在两个有效值',
    );
    expect(conflicted.statusCode).toBe(200);
    expect(conflicted.json().data.status).toBe('conflicted');
    const retired = await adjudicate(
      application,
      tokens,
      { id: fact.id, updatedAt: conflicted.json().data.updated_at },
      'retired',
      '该记录不再参与后续事实检索',
    );
    expect(retired.statusCode).toBe(200);
    expect(retired.json().data.status).toBe('retired');
    const terminal = await adjudicate(
      application,
      tokens,
      { id: fact.id, updatedAt: retired.json().data.updated_at },
      'verified',
      '尝试恢复退役事实',
    );
    expectApiError(terminal, 409, 'STATE_TRANSITION_INVALID');
    expect(
      await database<{ action: string }[]>`
        SELECT action FROM audit_events WHERE resource_id = ${fact.id}::uuid ORDER BY created_at
      `,
    ).toEqual([{ action: 'knowledge.fact.conflicted' }, { action: 'knowledge.fact.retired' }]);

    const isolated = await insertFact(database, {
      objectValue: '2026年1月',
      predicate: '发布日期',
      sourceDocumentId: SOURCE_B,
      subject: '北辰系统',
      workspaceId: WORKSPACE_B,
    });
    const meaninglessConflict = await adjudicate(
      application,
      tokens,
      isolated,
      'conflicted',
      '没有竞争值',
    );
    expectApiError(meaninglessConflict, 409, 'STATE_TRANSITION_INVALID');
  });

  it('enforces HTTP role, live service role, workspace scope, tenant isolation, and strict DTOs', async () => {
    const database = requireClient(client);
    const visible = await insertFact(database, {
      objectValue: '2025年9月',
      sourceDocumentId: SOURCE_A,
      workspaceId: WORKSPACE_A,
    });
    const hidden = await insertFact(database, {
      objectValue: '2026年1月',
      predicate: '发布日期',
      sourceDocumentId: SOURCE_B,
      subject: '北辰系统',
      workspaceId: WORKSPACE_B,
    });
    const other = await insertFact(database, {
      objectValue: '2027年3月',
      predicate: '发布日期',
      sourceDocumentId: OTHER_SOURCE,
      subject: '其他租户产品',
      tenantId: OTHER_TENANT,
      workspaceId: OTHER_WORKSPACE,
    });

    const viewer = await createSession(database, VIEWER, TENANT);
    expectApiError(
      await adjudicate(application, viewer, visible, 'retired', 'Viewer 不可裁决'),
      403,
      'PERMISSION_DENIED',
    );
    const reviewer = await createSession(database, REVIEWER, TENANT);
    expectApiError(
      await adjudicate(application, reviewer, hidden, 'retired', '越权工作区'),
      404,
      'RESOURCE_NOT_FOUND',
    );
    expectApiError(
      await adjudicate(application, reviewer, other, 'retired', '跨租户'),
      404,
      'RESOURCE_NOT_FOUND',
    );

    const malformed = await requireServer(application).inject({
      headers: writeHeaders(reviewer),
      method: 'POST',
      payload: {
        decision: 'verified',
        expected_updated_at: visible.updatedAt,
        reason: '',
        unexpected: true,
      },
      url: `${API_PATH}/not-a-uuid/verify`,
    });
    expectApiError(malformed, 422, 'SCHEMA_VALIDATION_FAILED');

    await database`
      UPDATE memberships SET role_code = 'viewer'
      WHERE tenant_id = ${TENANT}::uuid AND user_id = ${REVIEWER}::uuid
    `;
    await expect(
      requireApplication(application).get(FactAdjudicationService).adjudicate(
        TENANT,
        REVIEWER,
        visible.id,
        {
          decision: 'retired',
          expected_updated_at: visible.updatedAt,
          reason: '服务层权限复核',
        },
        { requestId: randomUUID() },
      ),
    ).rejects.toBeInstanceOf(FactAdjudicationNotFoundError);
  });

  it('serializes concurrent decisions and rejects stale or mismatched revision tokens', async () => {
    const database = requireClient(client);
    const fact = await insertFact(database, {
      objectValue: '2025年9月',
      sourceDocumentId: SOURCE_A,
      workspaceId: WORKSPACE_A,
    });
    const reviewer = await createSession(database, REVIEWER, TENANT);
    const [verified, retired] = await Promise.all([
      adjudicate(application, reviewer, fact, 'verified', '并发确认'),
      adjudicate(application, reviewer, fact, 'retired', '并发退役'),
    ]);
    expect([verified.statusCode, retired.statusCode].sort()).toEqual([200, 409]);
    expect([verified.json().error?.code, retired.json().error?.code]).toContain('VERSION_CONFLICT');
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM audit_events WHERE resource_id = ${fact.id}::uuid
      `,
    ).toEqual([{ count: 1 }]);

    const firstValue = await insertFact(database, {
      objectValue: '9999元',
      predicate: '价格',
      sourceDocumentId: SOURCE_A,
      subject: '价格竞争',
      workspaceId: WORKSPACE_A,
    });
    const secondValue = await insertFact(database, {
      objectValue: '8999元',
      predicate: '价格',
      sourceDocumentId: SOURCE_A,
      subject: '价格竞争',
      workspaceId: WORKSPACE_A,
    });
    const siblingDecisions = await Promise.all([
      adjudicate(application, reviewer, firstValue, 'conflicted', '并发标记第一个竞争值'),
      adjudicate(application, reviewer, secondValue, 'conflicted', '并发标记第二个竞争值'),
    ]);
    expect(siblingDecisions.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(
      await database<{ status: string }[]>`
        SELECT status FROM facts
        WHERE id IN (${firstValue.id}::uuid, ${secondValue.id}::uuid)
        ORDER BY id
      `,
    ).toEqual([{ status: 'conflicted' }, { status: 'conflicted' }]);

    const mismatch = await requireServer(application).inject({
      headers: { ...writeHeaders(reviewer), 'if-match': '"2000-01-01T00:00:00.000Z"' },
      method: 'POST',
      payload: {
        decision: 'retired',
        expected_updated_at: fact.updatedAt,
        reason: 'Header 与请求体不一致',
      },
      url: `${API_PATH}/${fact.id}/verify`,
    });
    expectApiError(mismatch, 409, 'VERSION_CONFLICT');
  });

  it('refuses verification without eligible, intact evidence or when a competing value is verified', async () => {
    const database = requireClient(client);
    const processing = await insertFact(database, {
      objectValue: '2025年9月',
      sourceDocumentId: SOURCE_PROCESSING,
      workspaceId: WORKSPACE_A,
    });
    const untrusted = await insertFact(database, {
      objectValue: '2025年10月',
      sourceDocumentId: SOURCE_UNTRUSTED,
      workspaceId: WORKSPACE_A,
    });
    const poisoned = await insertFact(database, {
      objectValue: '9999元',
      quoteText: '并不存在于原文中的伪造引文',
      sourceDocumentId: SOURCE_A,
      subject: '价格记录',
      workspaceId: WORKSPACE_A,
    });
    const verified = await insertFact(database, {
      objectValue: '2025年9月',
      sourceDocumentId: SOURCE_A,
      status: 'verified',
      workspaceId: WORKSPACE_A,
    });
    const competitor = await insertFact(database, {
      objectValue: '2025年10月',
      sourceDocumentId: SOURCE_A,
      workspaceId: WORKSPACE_A,
    });
    const admin = await createSession(database, ADMIN, TENANT);

    for (const [fact, reason] of [
      [processing, '资料仍在处理'],
      [untrusted, '来源不可信'],
      [poisoned, '引文完整性失败'],
      [competitor, '已有不同 verified 值'],
    ] as const) {
      const response = await adjudicate(application, admin, fact, 'verified', reason);
      expectApiError(response, 409, 'STATE_TRANSITION_INVALID');
    }
    expect(verified.id).not.toBe(competitor.id);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM audit_events WHERE resource_type = 'fact'
      `,
    ).toEqual([{ count: 0 }]);
  });

  it('rolls back the status change when the mandatory audit write fails', async () => {
    const database = requireClient(client);
    const fact = await insertFact(database, {
      objectValue: '2025年9月',
      sourceDocumentId: SOURCE_A,
      workspaceId: WORKSPACE_A,
    });
    await database`
      CREATE FUNCTION reject_test_fact_audit()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.resource_type = 'fact' THEN
          RAISE EXCEPTION 'test audit rejection';
        END IF;
        RETURN NEW;
      END;
      $$
    `;
    await database`
      CREATE TRIGGER reject_test_fact_audit_trigger
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION reject_test_fact_audit()
    `;
    try {
      await expect(
        requireApplication(application).get(FactAdjudicationService).adjudicate(
          TENANT,
          REVIEWER,
          fact.id,
          {
            decision: 'verified',
            expected_updated_at: fact.updatedAt,
            reason: '审计失败必须回滚',
          },
          { requestId: randomUUID() },
        ),
      ).rejects.toThrow(/test audit rejection/u);
      expect(
        await database<{ status: string }[]>`SELECT status FROM facts WHERE id = ${fact.id}::uuid`,
      ).toEqual([{ status: 'candidate' }]);
      expect(
        await database<{ count: number }[]>`SELECT count(*)::integer AS count FROM audit_events`,
      ).toEqual([{ count: 0 }]);
    } finally {
      await database`DROP TRIGGER reject_test_fact_audit_trigger ON audit_events`;
      await database`DROP FUNCTION reject_test_fact_audit()`;
    }
  });
});

interface FactFixture {
  readonly id: string;
  readonly updatedAt: string;
}

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id, email, display_name, status) VALUES
      (${REVIEWER}, 'fact-reviewer@example.com', 'Fact Reviewer', 'active'),
      (${ADMIN}, 'fact-admin@example.com', 'Fact Admin', 'active'),
      (${VIEWER}, 'fact-viewer@example.com', 'Fact Viewer', 'active'),
      (${OTHER_OWNER}, 'other-fact-owner@example.com', 'Other Fact Owner', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status) VALUES
      (${TENANT}, 'Fact Adjudication Tenant', 'fact-adjudication', 'active'),
      (${OTHER_TENANT}, 'Other Fact Tenant', 'other-fact-adjudication', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status) VALUES
      (${TENANT}, ${REVIEWER}, 'reviewer', 'active'),
      (${TENANT}, ${ADMIN}, 'tenant_admin', 'active'),
      (${TENANT}, ${VIEWER}, 'viewer', 'active'),
      (${OTHER_TENANT}, ${OTHER_OWNER}, 'tenant_owner', 'active')
  `;
  await database`
    INSERT INTO workspaces (id, tenant_id, name, slug, timezone) VALUES
      (${WORKSPACE_A}, ${TENANT}, 'Fact Workspace A', 'fact-a', 'Asia/Shanghai'),
      (${WORKSPACE_B}, ${TENANT}, 'Fact Workspace B', 'fact-b', 'Asia/Shanghai'),
      (${OTHER_WORKSPACE}, ${OTHER_TENANT}, 'Other Fact Workspace', 'other-fact', 'UTC')
  `;
  await database`
    INSERT INTO workspace_memberships (workspace_id, user_id, scope_json)
    VALUES (
      ${WORKSPACE_A},
      ${REVIEWER},
      ${JSON.stringify({ project_ids: [], schema_version: 'workspace-scope@1' })}::text::jsonb
    )
  `;
  await insertSource(database, {
    contentHash: '1'.repeat(64),
    id: SOURCE_A,
    status: 'active',
    text: SOURCE_A_TEXT,
    trustLevel: 'normal',
    workspaceId: WORKSPACE_A,
  });
  await insertSource(database, {
    contentHash: '2'.repeat(64),
    id: SOURCE_B,
    status: 'active',
    text: SOURCE_B_TEXT,
    trustLevel: 'verified',
    workspaceId: WORKSPACE_B,
  });
  await insertSource(database, {
    contentHash: '3'.repeat(64),
    id: SOURCE_PROCESSING,
    status: 'processing',
    text: SOURCE_A_TEXT,
    trustLevel: 'normal',
    workspaceId: WORKSPACE_A,
  });
  await insertSource(database, {
    contentHash: '4'.repeat(64),
    id: SOURCE_UNTRUSTED,
    status: 'active',
    text: SOURCE_A_TEXT,
    trustLevel: 'untrusted',
    workspaceId: WORKSPACE_A,
  });
  await insertSource(database, {
    contentHash: '5'.repeat(64),
    createdBy: OTHER_OWNER,
    id: OTHER_SOURCE,
    status: 'active',
    tenantId: OTHER_TENANT,
    text: '其他租户产品发布日期为2027年3月。',
    trustLevel: 'verified',
    workspaceId: OTHER_WORKSPACE,
  });
}

async function insertSource(
  database: Sql,
  input: {
    readonly contentHash: string;
    readonly createdBy?: string;
    readonly id: string;
    readonly status: 'active' | 'processing';
    readonly tenantId?: string;
    readonly text: string;
    readonly trustLevel: 'normal' | 'untrusted' | 'verified';
    readonly workspaceId: string;
  },
): Promise<void> {
  const tenantId = input.tenantId ?? TENANT;
  await database`
    INSERT INTO source_documents (
      id, tenant_id, workspace_id, title, source_type, mime_type, uri,
      content_hash, trust_level, status, created_by
    ) VALUES (
      ${input.id}, ${tenantId}, ${input.workspaceId}, ${`Source ${input.id}`},
      'txt', 'text/plain', ${`memory://${input.id}`}, ${input.contentHash},
      ${input.trustLevel}, ${input.status}, ${input.createdBy ?? ADMIN}
    )
  `;
  await database`
    INSERT INTO source_chunks (
      tenant_id, source_document_id, chunk_no, text, text_hash,
      metadata_json, token_count, status
    ) VALUES (
      ${tenantId}, ${input.id}, 0, ${input.text}, ${sha256(input.text)},
      ${JSON.stringify({ char_end: input.text.length, char_start: 0, schema_version: 'chunk-metadata@1' })}::text::jsonb,
      30, 'active'
    )
  `;
}

async function insertFact(
  database: Sql,
  input: {
    readonly objectValue: string;
    readonly predicate?: string;
    readonly quoteText?: string;
    readonly sourceDocumentId: string;
    readonly status?: 'candidate' | 'conflicted' | 'retired' | 'verified';
    readonly subject?: string;
    readonly tenantId?: string;
    readonly workspaceId: string;
  },
): Promise<FactFixture> {
  const tenantId = input.tenantId ?? TENANT;
  const facts = await database<{ id: string; updatedAt: string }[]>`
    INSERT INTO facts (
      tenant_id, workspace_id, subject, predicate, object_value, confidence, status
    ) VALUES (
      ${tenantId}, ${input.workspaceId}, ${input.subject ?? '星云系统'},
      ${input.predicate ?? '上市时间'}, ${input.objectValue}, 0.8, ${input.status ?? 'candidate'}
    )
    RETURNING
      id,
      to_char(
        updated_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS "updatedAt"
  `;
  const fact = facts[0];
  if (!fact) throw new Error('Expected fact fixture');
  const chunks = await database<{ id: string }[]>`
    SELECT id FROM source_chunks
    WHERE tenant_id = ${tenantId}::uuid AND source_document_id = ${input.sourceDocumentId}::uuid
    LIMIT 1
  `;
  const chunk = chunks[0];
  if (!chunk) throw new Error('Expected source chunk fixture');
  const quoteText = input.quoteText ?? input.objectValue;
  await database`
    INSERT INTO fact_sources (tenant_id, fact_id, chunk_id, quote_text, quote_hash)
    VALUES (${tenantId}, ${fact.id}, ${chunk.id}, ${quoteText}, ${sha256(quoteText)})
  `;
  return { id: fact.id, updatedAt: fact.updatedAt };
}

async function adjudicate(
  application: NestFastifyApplication | undefined,
  tokens: { readonly csrf: string; readonly session: string },
  fact: FactFixture,
  decision: 'conflicted' | 'retired' | 'verified',
  reason: string,
) {
  return requireServer(application).inject({
    headers: { ...writeHeaders(tokens), 'if-match': `"${fact.updatedAt}"` },
    method: 'POST',
    payload: { decision, expected_updated_at: fact.updatedAt, reason },
    url: `${API_PATH}/${fact.id}/verify`,
  });
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

function expectApiError(
  response: {
    readonly body: string;
    readonly json: () => { readonly error?: { readonly code?: unknown } };
    readonly statusCode: number;
  },
  status: number,
  code: string,
): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json().error?.code).toBe(code);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function requireApplication(
  application: NestFastifyApplication | undefined,
): NestFastifyApplication {
  if (!application) throw new Error('Fact adjudication test application was not initialized');
  return application;
}

function requireServer(application: NestFastifyApplication | undefined): FastifyInstance {
  return requireApplication(application).getHttpAdapter().getInstance();
}

function requireClient(value: Sql | undefined): Sql {
  if (!value) throw new Error('Fact adjudication PostgreSQL client was not initialized');
  return value;
}
