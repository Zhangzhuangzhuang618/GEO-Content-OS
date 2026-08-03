import {
  BriefResponseSchema,
  GenerationRunResponseSchema,
  TopicCandidatePageSchema,
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
import { TopicService } from '../../src/modules/workspace/topics/index.js';

const OWNER_ID = '12000000-0000-4000-8000-000000000026';
const STRATEGY_ID = '12000000-0000-4000-8000-000000000126';
const SCOPED_ID = '12000000-0000-4000-8000-000000000226';
const CONTENT_ID = '12000000-0000-4000-8000-000000000326';
const OTHER_OWNER_ID = '12000000-0000-4000-8000-000000000426';
const TENANT_ID = '22000000-0000-4000-8000-000000000026';
const OTHER_TENANT_ID = '22000000-0000-4000-8000-000000000126';
const WORKSPACE_A = '32000000-0000-4000-8000-000000000026';
const WORKSPACE_B = '32000000-0000-4000-8000-000000000126';
const OTHER_WORKSPACE = '32000000-0000-4000-8000-000000000226';
const PROJECT_A = '42000000-0000-4000-8000-000000000026';
const PROJECT_B = '42000000-0000-4000-8000-000000000126';
const OTHER_PROJECT = '42000000-0000-4000-8000-000000000226';
const KEYWORD_SET_A = '52000000-0000-4000-8000-000000000026';
const KEYWORD_SET_B = '52000000-0000-4000-8000-000000000126';
const OTHER_KEYWORD_SET = '52000000-0000-4000-8000-000000000226';
const KEYWORD_A = '62000000-0000-4000-8000-000000000026';
const KEYWORD_B = '62000000-0000-4000-8000-000000000126';
const OTHER_KEYWORD = '62000000-0000-4000-8000-000000000226';
const SOURCE_A = '72000000-0000-4000-8000-000000000026';
const SOURCE_B = '72000000-0000-4000-8000-000000000126';
const PLAN_PATH = '/api/v1/topic-plans/generate';
const CANDIDATE_PATH = '/api/v1/topic-candidates';

describe('topic API', () => {
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
    await database`TRUNCATE brief_sources, brief_keywords, briefs, topic_candidates, generation_runs, keywords, keyword_sets, brand_profiles, workspace_memberships, projects, workspaces, audit_events, outbox_events, support_access_grants, idempotency_records, password_reset_tokens, invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
    await database`
      INSERT INTO users (id, email, display_name, status)
      VALUES
        (${OWNER_ID}, 'topic-owner@example.com', 'Topic Owner', 'active'),
        (${STRATEGY_ID}, 'topic-strategy@example.com', 'Topic Strategy', 'active'),
        (${SCOPED_ID}, 'topic-scoped@example.com', 'Topic Scoped', 'active'),
        (${CONTENT_ID}, 'topic-content@example.com', 'Topic Content', 'active'),
        (${OTHER_OWNER_ID}, 'other-topic-owner@example.com', 'Other Topic Owner', 'active')
    `;
    await database`
      INSERT INTO tenants (id, name, slug, status)
      VALUES
        (${TENANT_ID}, 'Topic Tenant', 'topic-api-tenant', 'active'),
        (${OTHER_TENANT_ID}, 'Other Topic Tenant', 'other-topic-api-tenant', 'active')
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
        (${WORKSPACE_A}, ${TENANT_ID}, 'Topic Workspace A', 'topic-a', 'UTC'),
        (${WORKSPACE_B}, ${TENANT_ID}, 'Topic Workspace B', 'topic-b', 'UTC'),
        (${OTHER_WORKSPACE}, ${OTHER_TENANT_ID}, 'Other Topic Workspace', 'other-topic', 'UTC')
    `;
    await database`
      INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id)
      VALUES
        (${PROJECT_A}, ${TENANT_ID}, ${WORKSPACE_A}, 'Topic Project A', ${OWNER_ID}),
        (${PROJECT_B}, ${TENANT_ID}, ${WORKSPACE_B}, 'Topic Project B', ${OWNER_ID}),
        (${OTHER_PROJECT}, ${OTHER_TENANT_ID}, ${OTHER_WORKSPACE}, 'Other Topic Project', ${OTHER_OWNER_ID})
    `;
    await database`
      INSERT INTO source_documents (
        id, tenant_id, workspace_id, project_id, title, source_type, mime_type,
        uri, content_hash, status, created_by
      ) VALUES
        (
          ${SOURCE_A}, ${TENANT_ID}, ${WORKSPACE_A}, ${PROJECT_A}, 'Topic evidence A',
          'txt', 'text/plain', 'memory://topic-evidence-a', ${'a'.repeat(64)}, 'active', ${OWNER_ID}
        ),
        (
          ${SOURCE_B}, ${TENANT_ID}, ${WORKSPACE_A}, ${PROJECT_A}, 'Topic evidence B',
          'txt', 'text/plain', 'memory://topic-evidence-b', ${'b'.repeat(64)}, 'active', ${OWNER_ID}
        )
    `;
    await database`
      INSERT INTO keyword_sets (id, tenant_id, project_id, name)
      VALUES
        (${KEYWORD_SET_A}, ${TENANT_ID}, ${PROJECT_A}, 'Topic keywords A'),
        (${KEYWORD_SET_B}, ${TENANT_ID}, ${PROJECT_B}, 'Topic keywords B'),
        (${OTHER_KEYWORD_SET}, ${OTHER_TENANT_ID}, ${OTHER_PROJECT}, 'Other topic keywords')
    `;
    await database`
      INSERT INTO keywords (
        id, tenant_id, keyword_set_id, term, intent, intents, priority, platform_scope
      ) VALUES
        (${KEYWORD_A}, ${TENANT_ID}, ${KEYWORD_SET_A}, 'Enterprise GEO', 'informational', ARRAY['informational','commercial'], 90, ARRAY['official_site']),
        (${KEYWORD_B}, ${TENANT_ID}, ${KEYWORD_SET_B}, 'Other project GEO', 'commercial', ARRAY['commercial'], 80, ARRAY['zhihu']),
        (${OTHER_KEYWORD}, ${OTHER_TENANT_ID}, ${OTHER_KEYWORD_SET}, 'Cross tenant GEO', 'informational', ARRAY['informational'], 70, ARRAY['douyin'])
    `;
  });

  afterAll(async () => {
    await application?.close();
    await client?.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = originalDatabaseUrl;
  });

  it('queues one idempotent Topic Planner run with an atomic outbox event and audit', async () => {
    const database = requireClient(client);
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    const request = planRequest(strategy, 'topic-plan-001');
    const first = await requireServer(application).inject(request);
    const replay = await requireServer(application).inject(request);
    expect(first.statusCode).toBe(202);
    expect(GenerationRunResponseSchema.safeParse(first.json()).success).toBe(true);
    expect(first.json().data).toMatchObject({
      model_key: 'mock-topic-planner',
      project_id: PROJECT_A,
      skill_name: 'topic-planner',
      status: 'queued',
      tenant_id: TENANT_ID,
      version: 1,
      workspace_id: WORKSPACE_A,
    });
    expect(replay.json().data.id).toBe(first.json().data.id);
    const outbox = await database<
      { aggregateType: string; eventType: string; payload: { data: { requested_by: string } } }[]
    >`
      SELECT
        aggregate_type AS "aggregateType",
        event_type AS "eventType",
        payload_json AS payload
      FROM outbox_events
    `;
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      aggregateType: 'generation_run',
      eventType: 'strategy.topic_plan.generation_requested.v1',
      payload: { data: { requested_by: STRATEGY_ID } },
    });
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM audit_events WHERE action = 'topic_plan.requested'
      `,
    ).toEqual([{ count: 1 }]);

    const content = await createSession(database, CONTENT_ID, TENANT_ID);
    expect(
      (await requireServer(application).inject(planRequest(content, 'topic-plan-002'))).statusCode,
    ).toBe(403);
    const forged = planRequest(strategy, 'topic-plan-003');
    forged.payload.keyword_set_ids = [OTHER_KEYWORD_SET];
    expect((await requireServer(application).inject(forged)).statusCode).toBe(404);
  });

  it('persists validated planner output idempotently and serves scoped stable pagination', async () => {
    const database = requireClient(client);
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    const queued = await requireServer(application).inject(planRequest(strategy, 'topic-plan-004'));
    const runId = queued.json().data.id as string;
    const service = requireTopicService(application);
    const output = plannerOutput();
    const completed = await service.completeRun(TENANT_ID, runId, output);
    const replay = await service.completeRun(TENANT_ID, runId, output);
    expect(completed).toHaveLength(3);
    expect(replay.map((topic) => topic.id).sort()).toEqual(
      completed.map((topic) => topic.id).sort(),
    );
    expect(
      await database<{ status: string; version: number }[]>`
        SELECT status, version FROM generation_runs WHERE id = ${runId}
      `,
    ).toEqual([{ status: 'succeeded', version: 2 }]);

    await database`
      INSERT INTO workspace_memberships (workspace_id, user_id, scope_json)
      VALUES (
        ${WORKSPACE_A},
        ${SCOPED_ID},
        ${JSON.stringify({ project_ids: [PROJECT_A], schema_version: 'workspace-scope@1' })}::text::jsonb
      )
    `;
    const scoped = await createSession(database, SCOPED_ID, TENANT_ID);
    const page = await requireServer(application).inject({
      headers: readHeaders(scoped),
      method: 'GET',
      url: `${CANDIDATE_PATH}?limit=1&project_id=${PROJECT_A}`,
    });
    expect(page.statusCode).toBe(200);
    expect(TopicCandidatePageSchema.safeParse(page.json()).success).toBe(true);
    expect(page.json().data).toHaveLength(1);
    expect(page.json().meta.next_cursor).toBeTypeOf('string');
    const next = await requireServer(application).inject({
      headers: readHeaders(scoped),
      method: 'GET',
      url: `${CANDIDATE_PATH}?limit=2&project_id=${PROJECT_A}&cursor=${encodeURIComponent(page.json().meta.next_cursor)}`,
    });
    expect(next.statusCode).toBe(200);
    expect(next.json().data).toHaveLength(2);
    expect(new Set([...page.json().data, ...next.json().data].map((topic) => topic.id)).size).toBe(
      3,
    );

    const riskFiltered = await requireServer(application).inject({
      headers: readHeaders(scoped),
      method: 'GET',
      url: `${CANDIDATE_PATH}?risk_level=high&platform_code=xiaohongshu`,
    });
    expect(riskFiltered.json().data).toHaveLength(1);
    expect(riskFiltered.json().data[0].evidence_ids).toEqual([]);
  });

  it('adopts only evidenced topics into one atomic Brief and replays concurrent requests', async () => {
    const database = requireClient(client);
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    const queued = await requireServer(application).inject(planRequest(strategy, 'topic-plan-005'));
    const topics = await requireTopicService(application).completeRun(
      TENANT_ID,
      queued.json().data.id,
      plannerOutput(),
    );
    const evidenced = topics.find((topic) => topic.question.includes('operationalize'));
    const unsupported = topics.find((topic) => topic.evidence_ids.length === 0);
    const concurrent = topics.find((topic) => topic.question.includes('measure'));
    if (!evidenced || !unsupported || !concurrent) throw new Error('Expected topic fixtures');

    const adoptRequest = (topicId: string, payload: Record<string, unknown> = {}) => ({
      headers: { ...writeHeaders(strategy), 'if-match': '"1"' },
      method: 'POST' as const,
      payload,
      url: `${CANDIDATE_PATH}/${topicId}/adopt`,
    });
    const adopted = await requireServer(application).inject(adoptRequest(evidenced.id));
    const replay = await requireServer(application).inject(adoptRequest(evidenced.id));
    expect(adopted.statusCode).toBe(200);
    expect(BriefResponseSchema.safeParse(adopted.json()).success).toBe(true);
    expect(adopted.json().data).toMatchObject({
      keyword_ids: [KEYWORD_A],
      primary_keyword_id: KEYWORD_A,
      project_id: PROJECT_A,
      source_ids: [SOURCE_A],
      source_topic_candidate_id: evidenced.id,
    });
    expect(replay.json().data.id).toBe(adopted.json().data.id);
    expect((await requireServer(application).inject(adoptRequest(unsupported.id))).statusCode).toBe(
      409,
    );

    const invalidKeyword = await requireServer(application).inject(
      adoptRequest(concurrent.id, {
        keyword_ids: [KEYWORD_B],
        primary_keyword_id: KEYWORD_B,
      }),
    );
    expect(invalidKeyword.statusCode).toBe(404);
    expect(
      await database<{ status: string }[]>`
        SELECT status FROM topic_candidates WHERE id = ${concurrent.id}
      `,
    ).toEqual([{ status: 'proposed' }]);

    const [first, second] = await Promise.all([
      requireServer(application).inject(adoptRequest(concurrent.id)),
      requireServer(application).inject(adoptRequest(concurrent.id)),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().data.id).toBe(second.json().data.id);
    expect(
      await database<{ count: number }[]>`SELECT count(*)::integer AS count FROM briefs`,
    ).toEqual([{ count: 2 }]);
    expect(
      await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM audit_events
        WHERE action = 'topic_candidate.adopted'
      `,
    ).toEqual([{ count: 2 }]);
  });

  it('rejects invalid planner evidence risk in both runtime schema and database', async () => {
    const database = requireClient(client);
    const strategy = await createSession(database, STRATEGY_ID, TENANT_ID);
    const queued = await requireServer(application).inject(planRequest(strategy, 'topic-plan-006'));
    const runId = queued.json().data.id as string;
    const invalid = plannerOutput();
    invalid.topics[0]!.evidence_ids = [];
    invalid.topics[0]!.risk_level = 'medium';
    await expect(
      requireTopicService(application).completeRun(TENANT_ID, runId, invalid),
    ).rejects.toThrow();
    await expect(
      database`
        INSERT INTO topic_candidates (
          tenant_id, workspace_id, project_id, generation_run_id, question, intent,
          entities_json, evidence_summary_json, platform_codes, priority, risk_level
        ) VALUES (
          ${TENANT_ID}, ${WORKSPACE_A}, ${PROJECT_A}, ${runId},
          'What unsupported topic should be considered?', 'informational',
          ${JSON.stringify({ entities: ['GEO'], schema_version: 'entity-list@1' })}::text::jsonb,
          ${JSON.stringify({ evidence_ids: [], schema_version: 'citation-set@1' })}::text::jsonb,
          ARRAY['official_site'], 50, 'medium'
        )
      `,
    ).rejects.toThrow(/topic_candidates_evidence_risk_check/u);
  });
});

function planRequest(tokens: { readonly csrf: string; readonly session: string }, key: string) {
  return {
    headers: { ...writeHeaders(tokens), 'idempotency-key': key },
    method: 'POST' as const,
    payload: {
      keyword_set_ids: [KEYWORD_SET_A],
      max_topics: 3,
      platform_codes: ['official_site', 'zhihu', 'xiaohongshu'],
      project_id: PROJECT_A,
      seed_queries: ['enterprise GEO operations'],
      workspace_id: WORKSPACE_A,
    },
    url: PLAN_PATH,
  };
}

function plannerOutput() {
  return {
    topics: [
      topic(
        'How should enterprise teams operationalize GEO content?',
        90,
        'low',
        [SOURCE_A],
        ['official_site', 'zhihu'],
      ),
      topic('Which emerging GEO trend deserves future research?', 70, 'high', [], ['xiaohongshu']),
      topic(
        'How can enterprise teams measure GEO content quality?',
        80,
        'medium',
        [SOURCE_B],
        ['official_site'],
      ),
    ],
  };
}

function topic(
  question: string,
  priority: number,
  riskLevel: 'low' | 'medium' | 'high' | 'critical',
  evidenceIds: string[],
  platformCodes: string[],
) {
  return {
    brief_suggestion: {
      audience: 'Enterprise marketing and content operations leaders',
      constraints: {},
      due_at: null,
      keyword_ids: [KEYWORD_A],
      objective: 'education',
      primary_keyword_id: KEYWORD_A,
      title: question.slice(0, 80),
    },
    entities: ['GEO', 'enterprise content'],
    evidence_ids: evidenceIds,
    intent: 'informational',
    platform_codes: platformCodes,
    priority,
    question,
    risk_level: riskLevel,
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

function requireTopicService(application: NestFastifyApplication | undefined): TopicService {
  if (!application) throw new Error('Topic test application was not initialized');
  return application.get(TopicService);
}

function requireServer(application: NestFastifyApplication | undefined): FastifyInstance {
  if (!application) throw new Error('Topic test application was not initialized');
  return application.getHttpAdapter().getInstance();
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('Topic PostgreSQL client was not initialized');
  return client;
}
