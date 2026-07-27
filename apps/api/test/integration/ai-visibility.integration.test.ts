import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import {
  MODEL_ADAPTER_VERSION,
  type ModelAdapter,
  type ModelRequest,
} from '@geo-content-os/adapter-model';
import { VisibilityProbeWorker } from '@geo-content-os/worker-ai';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/database/migrate.js';
import {
  AiVisibilityService,
  AiVisibilityValidationError,
} from '../../src/modules/analytics/ai-visibility/index.js';
import type { AnalyticsApiScope } from '../../src/modules/analytics/analytics-api.types.js';
import { OutboxWriter } from '../../src/modules/outbox/index.js';

const USER = '11000000-0000-4000-8000-000000000139';
const TENANT = '21000000-0000-4000-8000-000000000139';
const WORKSPACE = '31000000-0000-4000-8000-000000000139';
const PROJECT = '41000000-0000-4000-8000-000000000139';
const SCOPE: AnalyticsApiScope = {
  requestId: 'ai-visibility-request-139',
  tenantId: TENANT,
  userId: USER,
};

describe('AI visibility query sets and runs', () => {
  let client: Sql | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 4, prepare: false });
  }, 120_000);

  beforeEach(async () => {
    const database = requireClient(client);
    await database`TRUNCATE users, tenants CASCADE`;
    await seed(database);
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('creates an immutable 30-question set and queues a scoped DeepSeek run', async () => {
    const database = requireClient(client);
    const service = new AiVisibilityService(database, new OutboxWriter(database));
    const querySet = await database.begin((transaction) =>
      service.createQuerySet(transaction, SCOPE, {
        brand_aliases: ['广州志远搬家'],
        brand_name: '志远搬家',
        competitor_names: ['竞品甲', '竞品乙'],
        industry: '搬家服务',
        locale: 'zh-CN',
        market: '广州',
        name: '广州搬家 AI 可见度基准',
        positioning: '正规团队与稳定履约',
        project_id: PROJECT,
        workspace_id: WORKSPACE,
      }),
    );

    expect(querySet.query_count).toBe(30);
    expect(new Set(querySet.queries.map((query) => query.intent_code)).size).toBe(6);
    expect(
      querySet.queries
        .filter((query) => query.intent_code !== 'brand_recognition')
        .every(
          (query) =>
            !query.query_text.includes('志远搬家') && !query.query_text.includes('广州志远搬家'),
        ),
    ).toBe(true);
    await expect(
      database`UPDATE ai_visibility_query_sets SET name = '静默改写' WHERE id = ${querySet.id}::uuid`,
    ).rejects.toThrow('immutable');

    const runs = await database.begin((transaction) =>
      service.createRuns(transaction, SCOPE, {
        engine_codes: ['deepseek'],
        query_set_id: querySet.id,
        workspace_id: WORKSPACE,
      }),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      engine_code: 'deepseek',
      query_count: 30,
      retrieval_mode: 'model_only',
      status: 'queued',
    });
    const events = await database<{ aggregateType: string; eventType: string; payload: unknown }[]>`
      SELECT aggregate_type AS "aggregateType", event_type AS "eventType",
        payload_json AS payload
      FROM outbox_events
    `;
    expect(events[0]).toMatchObject({
      aggregateType: 'visibility_run',
      eventType: 'analytics.visibility.probe_requested.v1',
    });

    const worker = new VisibilityProbeWorker(
      database,
      new Map([[runs[0]!.model_key, new VisibilityTestModel(runs[0]!.model_key)]]),
    );
    await expect(worker.run(events[0]!.payload)).resolves.toMatchObject({
      disposition: 'completed',
      status: 'succeeded',
    });
    expect(await database`SELECT id FROM ai_visibility_responses`).toHaveLength(30);
    const completed = await service.getRun(SCOPE, WORKSPACE, runs[0]!.id);
    expect(completed.status).toBe('succeeded');
    expect(completed.metrics?.answered_count).toBe(30);
    expect(completed.responses).toHaveLength(30);
    expect(completed.sources).toEqual([
      {
        domain: 'example.com',
        intent_codes: [
          'brand_recognition',
          'comparison',
          'education',
          'exploration',
          'procurement',
          'recommendation',
        ],
        level: 'domain',
        mention_count: 30,
        query_count: 30,
        url: null,
      },
      {
        domain: 'example.com',
        intent_codes: [
          'brand_recognition',
          'comparison',
          'education',
          'exploration',
          'procurement',
          'recommendation',
        ],
        level: 'url',
        mention_count: 30,
        query_count: 30,
        url: 'https://example.com/guide',
      },
    ]);
  });

  it('does not pretend unsupported AI engines are configured', async () => {
    const database = requireClient(client);
    const service = new AiVisibilityService(database, new OutboxWriter(database));
    const [querySet] = await service.listQuerySets(SCOPE, {
      status: 'active',
      workspace_id: WORKSPACE,
    });
    expect(querySet).toBeUndefined();
    const created = await database.begin((transaction) =>
      service.createQuerySet(transaction, SCOPE, {
        brand_aliases: [],
        brand_name: '志远搬家',
        competitor_names: ['竞品甲', '竞品乙'],
        industry: '搬家服务',
        locale: 'zh-CN',
        name: '引擎边界测试',
        project_id: PROJECT,
        workspace_id: WORKSPACE,
      }),
    );
    await expect(
      database.begin((transaction) =>
        service.createRuns(transaction, SCOPE, {
          engine_codes: ['qwen'],
          query_set_id: created.id,
          workspace_id: WORKSPACE,
        }),
      ),
    ).rejects.toBeInstanceOf(AiVisibilityValidationError);
    expect(await database`SELECT id FROM ai_visibility_runs`).toHaveLength(0);
  });
});

async function seed(database: Sql): Promise<void> {
  await database`
    INSERT INTO users (id,email,display_name,status)
    VALUES (${USER}::uuid,'ai-visibility-139@example.com','AI Visibility Analyst','active')
  `;
  await database`
    INSERT INTO tenants (id,name,slug,status)
    VALUES (${TENANT}::uuid,'AI Visibility Tenant','ai-visibility-tenant','active')
  `;
  await database`
    INSERT INTO memberships (tenant_id,user_id,role_code,status)
    VALUES (${TENANT}::uuid,${USER}::uuid,'tenant_admin','active')
  `;
  await database`
    INSERT INTO workspaces (id,tenant_id,name,slug,timezone,status)
    VALUES (${WORKSPACE}::uuid,${TENANT}::uuid,'AI Visibility Workspace','ai-visibility','UTC','active')
  `;
  await database`
    INSERT INTO projects (id,tenant_id,workspace_id,name,owner_id,status)
    VALUES (${PROJECT}::uuid,${TENANT}::uuid,${WORKSPACE}::uuid,'AI Visibility Project',${USER}::uuid,'active')
  `;
}

function requireClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('PostgreSQL test client is not initialized');
  return client;
}

class VisibilityTestModel implements ModelAdapter {
  public constructor(public readonly modelKey: string) {}

  public capabilities() {
    return {
      jsonMode: true,
      jsonSchema: false,
      maxOutputTokens: 8_000,
      streaming: false,
      toolCalling: false,
    };
  }

  public estimate(input: ModelRequest) {
    return {
      estimatedInputTokens: 10,
      maximumOutputTokens: input.maxOutputTokens,
      modelKey: this.modelKey,
    };
  }

  public async generate(input: ModelRequest) {
    const user = input.messages.find((message) => message.role === 'user');
    const question = user && 'content' in user ? user.content : '';
    return {
      adapterVersion: MODEL_ADAPTER_VERSION,
      finishReason: 'stop' as const,
      message: {
        content: `${question}\n志远搬家是一家正规、可靠、值得考虑的服务商。参考：https://example.com/guide`,
        role: 'assistant' as const,
      },
      usage: {
        durationMs: 1,
        inputTokens: 10,
        modelKey: this.modelKey,
        outputTokens: 20,
        providerCode: 'test',
        providerModelId: 'visibility-test-model',
        providerRequestId: `test-${input.requestId}`,
        totalTokens: 30,
      },
    };
  }

  public async *stream(input: ModelRequest) {
    const result = await this.generate(input);
    yield { result, type: 'done' as const };
  }
}
