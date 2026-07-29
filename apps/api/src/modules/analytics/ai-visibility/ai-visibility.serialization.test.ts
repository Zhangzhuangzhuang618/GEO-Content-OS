import type { TransactionSql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient } from '../../../database/index.js';
import type { OutboxWriter } from '../../outbox/index.js';
import { AiVisibilityService } from './ai-visibility.service.js';

const TENANT_ID = '10000000-0000-4000-8000-000000000201';
const USER_ID = '20000000-0000-4000-8000-000000000201';
const WORKSPACE_ID = '30000000-0000-4000-8000-000000000201';
const PROJECT_ID = '40000000-0000-4000-8000-000000000201';
const QUERY_SET_ID = '50000000-0000-4000-8000-000000000201';
const QUERY_ID = '60000000-0000-4000-8000-000000000201';
const RUN_ID = '70000000-0000-4000-8000-000000000201';
const RESPONSE_ID = '80000000-0000-4000-8000-000000000201';

describe('AI visibility serialization', () => {
  it('normalizes PostgreSQL timestamp strings in query sets, runs, and responses', async () => {
    const transaction = vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join(' ');
      if (sql.includes('FROM ai_visibility_runs AS run')) return [runRow()];
      if (sql.includes('FROM ai_visibility_query_sets AS query_set')) return [querySetRow()];
      if (sql.includes('FROM ai_visibility_queries')) return [queryRow()];
      if (sql.includes('FROM ai_visibility_responses AS response')) return [responseRow()];
      return [];
    }) as unknown as TransactionSql;
    const client = Object.assign(vi.fn(), {
      begin: async <T>(operation: (value: TransactionSql) => Promise<T>) => operation(transaction),
    });
    const service = new AiVisibilityService(
      client as unknown as DatabaseClient,
      {} as OutboxWriter,
    );

    const result = await service.getRun(
      { requestId: 'request-201', tenantId: TENANT_ID, userId: USER_ID },
      WORKSPACE_ID,
      RUN_ID,
    );

    expect(result).toMatchObject({
      created_at: '2026-07-29T01:00:00.000Z',
      finished_at: '2026-07-29T01:02:00.000Z',
      query_set: {
        created_at: '2026-07-29T00:58:00.000Z',
        queries: [{ created_at: '2026-07-29T00:59:00.000Z' }],
        updated_at: '2026-07-29T00:58:30.000Z',
      },
      responses: [{ observed_at: '2026-07-29T01:01:00.000Z' }],
      started_at: '2026-07-29T01:00:10.000Z',
      updated_at: '2026-07-29T01:02:01.000Z',
    });
  });
});

function querySetRow() {
  return {
    brandAliases: [],
    brandName: '志远搬家',
    competitorNames: ['竞品甲', '竞品乙'],
    createdAt: '2026-07-29 00:58:00+00',
    createdBy: USER_ID,
    id: QUERY_SET_ID,
    industry: '搬家服务',
    locale: 'zh-CN',
    market: '广州',
    methodologyVersion: 'ai-visibility@2',
    name: '广州搬家 AI 可见度基准',
    positioning: null,
    projectId: PROJECT_ID,
    revision: 1,
    seriesId: QUERY_SET_ID,
    status: 'active',
    updatedAt: '2026-07-29 00:58:30+00',
    workspaceId: WORKSPACE_ID,
  };
}

function queryRow() {
  return {
    commercialValue: 'high',
    createdAt: '2026-07-29 00:59:00+00',
    id: QUERY_ID,
    intentCode: 'brand_recognition',
    queryHash: 'a'.repeat(64),
    queryKey: 'q001',
    queryText: '志远搬家的服务怎么样？',
    sortOrder: 1,
  };
}

function runRow() {
  return {
    baselineRunId: null,
    completedCount: 1,
    competitors: [],
    createdAt: '2026-07-29 01:00:00+00',
    engineCode: 'deepseek',
    error: null,
    failedCount: 0,
    finishedAt: '2026-07-29 01:02:00+00',
    id: RUN_ID,
    methodologyVersion: 'ai-visibility@2',
    metrics: {},
    modelKey: 'deepseek-v4-flash',
    opportunities: [],
    projectId: PROJECT_ID,
    queryCount: 1,
    querySetId: QUERY_SET_ID,
    requestedBy: USER_ID,
    retrievalMode: 'model_only',
    score: '80',
    scoringVersion: 'ai-visibility-score@2',
    sources: [],
    startedAt: '2026-07-29 01:00:10+00',
    status: 'succeeded',
    updatedAt: '2026-07-29 01:02:01+00',
    version: 1,
    workspaceId: WORKSPACE_ID,
  };
}

function responseRow() {
  return {
    answerText: '回答',
    citations: [],
    competitors: [],
    error: null,
    id: RESPONSE_ID,
    observedAt: '2026-07-29 01:01:00+00',
    providerRequestId: null,
    queryId: QUERY_ID,
    recognitionStatus: 'recognized',
    recommended: true,
    responseHash: 'b'.repeat(64),
    sentiment: 'positive',
    targetMentioned: true,
    targetRank: 1,
    usage: {},
  };
}
