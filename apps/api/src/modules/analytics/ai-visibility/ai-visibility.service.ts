import type {
  AiVisibilityQuerySetCreate,
  AiVisibilityQuerySetListQuery,
  AiVisibilityQuerySetView,
  AiVisibilityRunCreate,
  AiVisibilityRunDetail,
  AiVisibilityRunListQuery,
  AiVisibilityRunSummary,
} from '@geo-content-os/contracts';
import { createHash, randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';

import type { DatabaseClient } from '../../../database/index.js';
import type { OutboxWriter } from '../../outbox/index.js';
import type { AnalyticsApiScope } from '../analytics-api.types.js';

interface AiVisibilityDatabaseProvider {
  readonly client: DatabaseClient;
}

interface QuerySetRow {
  readonly brandAliases: unknown;
  readonly brandName: string;
  readonly competitorNames: unknown;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly id: string;
  readonly industry: string;
  readonly locale: string;
  readonly market: string | null;
  readonly methodologyVersion: string;
  readonly name: string;
  readonly positioning: string | null;
  readonly projectId: string;
  readonly revision: number;
  readonly seriesId: string;
  readonly status: 'active' | 'archived';
  readonly updatedAt: Date;
  readonly workspaceId: string;
}

interface QueryRow {
  readonly commercialValue: 'high' | 'low' | 'medium';
  readonly createdAt: Date;
  readonly id: string;
  readonly intentCode:
    | 'brand_recognition'
    | 'comparison'
    | 'education'
    | 'exploration'
    | 'procurement'
    | 'recommendation';
  readonly queryHash: string;
  readonly queryKey: string;
  readonly queryText: string;
  readonly sortOrder: number;
}

interface RunRow {
  readonly baselineRunId: string | null;
  readonly completedCount: number;
  readonly competitors: unknown;
  readonly createdAt: Date;
  readonly engineCode: AiVisibilityRunSummary['engine_code'];
  readonly error: Readonly<Record<string, unknown>> | null;
  readonly failedCount: number;
  readonly finishedAt: Date | null;
  readonly id: string;
  readonly methodologyVersion: string;
  readonly metrics: unknown;
  readonly modelKey: string;
  readonly opportunities: unknown;
  readonly projectId: string;
  readonly queryCount: number;
  readonly querySetId: string;
  readonly requestedBy: string;
  readonly retrievalMode: AiVisibilityRunSummary['retrieval_mode'];
  readonly score: string | number | null;
  readonly scoringVersion: string;
  readonly sources: unknown;
  readonly startedAt: Date | null;
  readonly status: AiVisibilityRunSummary['status'];
  readonly updatedAt: Date;
  readonly version: number;
  readonly workspaceId: string;
}

interface ResponseRow {
  readonly answerText: string | null;
  readonly citations: unknown;
  readonly competitors: unknown;
  readonly error: Readonly<Record<string, unknown>> | null;
  readonly id: string;
  readonly observedAt: Date;
  readonly providerRequestId: string | null;
  readonly queryId: string;
  readonly recommended: boolean;
  readonly recognitionStatus:
    'misidentified' | 'not_applicable' | 'not_recognized' | 'recognized' | 'uncertain';
  readonly responseHash: string | null;
  readonly sentiment: 'negative' | 'neutral' | 'positive' | 'unknown';
  readonly targetMentioned: boolean;
  readonly targetRank: number | null;
  readonly usage: unknown;
}

interface NormalizedQuery {
  readonly commercialValue: 'high' | 'low' | 'medium';
  readonly intentCode: QueryRow['intentCode'];
  readonly queryHash: string;
  readonly queryKey: string;
  readonly queryText: string;
  readonly sortOrder: number;
}

const METHODOLOGY_VERSION = 'ai-visibility@2';
const SCORING_VERSION = 'ai-visibility-score@2';
const ENABLED_ENGINES = new Set(['deepseek']);

export class AiVisibilityService {
  public constructor(
    private readonly database: DatabaseClient | AiVisibilityDatabaseProvider,
    private readonly outbox: OutboxWriter,
  ) {}

  public async createQuerySet(
    transaction: TransactionSql,
    scope: AnalyticsApiScope,
    input: AiVisibilityQuerySetCreate,
  ): Promise<AiVisibilityQuerySetView> {
    await assertProjectAccess(transaction, scope, input.workspace_id, input.project_id);
    const competitors = uniqueNames(input.competitor_names, input.brand_name);
    if (competitors.length < 2) throw new AiVisibilityValidationError();
    const aliases = uniqueNames(input.brand_aliases, input.brand_name, false);
    const normalizedQueries = normalizeQueries(
      input.queries ??
        defaultQueries({
          brandName: input.brand_name,
          competitors,
          industry: input.industry,
          market: input.market ?? null,
        }),
      {
        aliases,
        brandName: input.brand_name,
      },
    );
    const id = randomUUID();
    const rows = await transaction<QuerySetRow[]>`
      INSERT INTO ai_visibility_query_sets (
        id, tenant_id, workspace_id, project_id, name, brand_name,
        brand_aliases_json, industry, market, positioning, competitor_names_json,
        locale, methodology_version, created_by
      ) VALUES (
        ${id}::uuid, ${scope.tenantId}::uuid, ${input.workspace_id}::uuid,
        ${input.project_id}::uuid, ${input.name}, ${input.brand_name},
        ${JSON.stringify(aliases)}::text::jsonb, ${input.industry}, ${input.market ?? null},
        ${input.positioning ?? null}, ${JSON.stringify(competitors)}::text::jsonb,
        ${input.locale}, ${METHODOLOGY_VERSION}, ${scope.userId}::uuid
      )
      RETURNING
        id, workspace_id AS "workspaceId", project_id AS "projectId",
        series_id AS "seriesId", revision, name, brand_name AS "brandName",
        brand_aliases_json AS "brandAliases", industry, market, positioning,
        competitor_names_json AS "competitorNames", locale, status,
        methodology_version AS "methodologyVersion", created_by AS "createdBy",
        created_at AS "createdAt", updated_at AS "updatedAt"
    `;
    const created = rows[0];
    if (!created) throw new AiVisibilityStateError();
    for (const query of normalizedQueries) {
      await transaction`
        INSERT INTO ai_visibility_queries (
          tenant_id, query_set_id, query_key, intent_code, query_text,
          query_hash, commercial_value, sort_order
        ) VALUES (
          ${scope.tenantId}::uuid, ${id}::uuid, ${query.queryKey}, ${query.intentCode},
          ${query.queryText}, ${query.queryHash}, ${query.commercialValue}, ${query.sortOrder}
        )
      `;
    }
    await audit(
      transaction,
      scope,
      'ai_visibility.query_set.created',
      'ai_visibility_query_set',
      id,
      {
        methodology_version: METHODOLOGY_VERSION,
        project_id: input.project_id,
        query_count: normalizedQueries.length,
        workspace_id: input.workspace_id,
      },
    );
    return toQuerySetView(created, await selectQueries(transaction, scope.tenantId, id));
  }

  public async listQuerySets(
    scope: AnalyticsApiScope,
    input: AiVisibilityQuerySetListQuery,
  ): Promise<readonly AiVisibilityQuerySetView[]> {
    return resolveClient(this.database).begin(async (transaction) => {
      await assertWorkspaceAccess(transaction, scope, input.workspace_id);
      const rows = await transaction<QuerySetRow[]>`
        SELECT
          query_set.id, query_set.workspace_id AS "workspaceId",
          query_set.project_id AS "projectId", query_set.series_id AS "seriesId",
          query_set.revision, query_set.name, query_set.brand_name AS "brandName",
          query_set.brand_aliases_json AS "brandAliases", query_set.industry,
          query_set.market, query_set.positioning,
          query_set.competitor_names_json AS "competitorNames", query_set.locale,
          query_set.status, query_set.methodology_version AS "methodologyVersion",
          query_set.created_by AS "createdBy", query_set.created_at AS "createdAt",
          query_set.updated_at AS "updatedAt"
        FROM ai_visibility_query_sets AS query_set
        WHERE query_set.tenant_id = ${scope.tenantId}::uuid
          AND query_set.workspace_id = ${input.workspace_id}::uuid
          AND query_set.status = ${input.status}
          AND (${input.project_id ?? null}::uuid IS NULL OR query_set.project_id = ${input.project_id ?? null}::uuid)
          AND has_project_scope_access(
            query_set.tenant_id, query_set.workspace_id, query_set.project_id,
            ${scope.userId}::uuid
          )
        ORDER BY query_set.created_at DESC, query_set.id
        LIMIT 100
      `;
      const views: AiVisibilityQuerySetView[] = [];
      for (const row of rows) {
        views.push(toQuerySetView(row, await selectQueries(transaction, scope.tenantId, row.id)));
      }
      return Object.freeze(views);
    });
  }

  public async createRuns(
    transaction: TransactionSql,
    scope: AnalyticsApiScope,
    input: AiVisibilityRunCreate,
  ): Promise<readonly AiVisibilityRunSummary[]> {
    const querySet = await selectQuerySet(
      transaction,
      scope,
      input.workspace_id,
      input.query_set_id,
    );
    if (querySet.status !== 'active') throw new AiVisibilityStateError();
    const engines = [...new Set(input.engine_codes)];
    if (engines.some((engine) => !ENABLED_ENGINES.has(engine))) {
      throw new AiVisibilityValidationError('Selected AI engine is not configured');
    }
    if (input.baseline_run_id && engines.length !== 1) throw new AiVisibilityValidationError();
    const queries = await selectQueries(transaction, scope.tenantId, querySet.id);
    if (queries.length === 0) throw new AiVisibilityStateError();
    const created: AiVisibilityRunSummary[] = [];
    for (const engine of engines) {
      if (input.baseline_run_id) {
        await assertBaseline(transaction, scope, input.baseline_run_id, querySet.id, engine);
      }
      const id = randomUUID();
      const modelKey = visibilityModelKey();
      const rows = await transaction<RunRow[]>`
        INSERT INTO ai_visibility_runs (
          id, tenant_id, workspace_id, project_id, query_set_id, baseline_run_id,
          engine_code, model_key, retrieval_mode, methodology_version,
          scoring_version, query_count, requested_by
        ) VALUES (
          ${id}::uuid, ${scope.tenantId}::uuid, ${querySet.workspaceId}::uuid,
          ${querySet.projectId}::uuid, ${querySet.id}::uuid,
          ${input.baseline_run_id ?? null}::uuid, ${engine}, ${modelKey}, 'model_only',
          ${querySet.methodologyVersion}, ${SCORING_VERSION}, ${queries.length},
          ${scope.userId}::uuid
        )
        RETURNING
          id, workspace_id AS "workspaceId", project_id AS "projectId",
          query_set_id AS "querySetId", baseline_run_id AS "baselineRunId",
          engine_code AS "engineCode", model_key AS "modelKey",
          retrieval_mode AS "retrievalMode", status,
          methodology_version AS "methodologyVersion",
          scoring_version AS "scoringVersion", query_count AS "queryCount",
          completed_count AS "completedCount", failed_count AS "failedCount", score,
          metrics_json AS metrics, competitors_json AS competitors,
          sources_json AS sources, opportunities_json AS opportunities,
          error_json AS error, requested_by AS "requestedBy",
          started_at AS "startedAt", finished_at AS "finishedAt", version,
          created_at AS "createdAt", updated_at AS "updatedAt"
      `;
      const row = rows[0];
      if (!row) throw new AiVisibilityStateError();
      await this.outbox.enqueue(
        {
          aggregateId: id,
          aggregateType: 'visibility_run',
          data: {
            ai_visibility_run_id: id,
            engine_code: engine,
            model_key: modelKey,
            workspace_id: querySet.workspaceId,
          },
          eventType: 'analytics.visibility.probe_requested.v1',
          tenantId: scope.tenantId,
        },
        transaction,
      );
      await audit(transaction, scope, 'ai_visibility.run.queued', 'ai_visibility_run', id, {
        engine_code: engine,
        query_set_id: querySet.id,
        workspace_id: querySet.workspaceId,
      });
      created.push(toRunSummary(row));
    }
    return Object.freeze(created);
  }

  public async listRuns(
    scope: AnalyticsApiScope,
    input: AiVisibilityRunListQuery,
  ): Promise<readonly AiVisibilityRunSummary[]> {
    return resolveClient(this.database).begin(async (transaction) => {
      await assertWorkspaceAccess(transaction, scope, input.workspace_id);
      const rows = await transaction<RunRow[]>`
        SELECT
          run.id, run.workspace_id AS "workspaceId", run.project_id AS "projectId",
          run.query_set_id AS "querySetId", run.baseline_run_id AS "baselineRunId",
          run.engine_code AS "engineCode", run.model_key AS "modelKey",
          run.retrieval_mode AS "retrievalMode", run.status,
          run.methodology_version AS "methodologyVersion",
          run.scoring_version AS "scoringVersion", run.query_count AS "queryCount",
          run.completed_count AS "completedCount", run.failed_count AS "failedCount",
          run.score, run.metrics_json AS metrics, run.competitors_json AS competitors,
          run.sources_json AS sources, run.opportunities_json AS opportunities,
          run.error_json AS error, run.requested_by AS "requestedBy",
          run.started_at AS "startedAt", run.finished_at AS "finishedAt", run.version,
          run.created_at AS "createdAt", run.updated_at AS "updatedAt"
        FROM ai_visibility_runs AS run
        WHERE run.tenant_id = ${scope.tenantId}::uuid
          AND run.workspace_id = ${input.workspace_id}::uuid
          AND (${input.project_id ?? null}::uuid IS NULL OR run.project_id = ${input.project_id ?? null}::uuid)
          AND (${input.query_set_id ?? null}::uuid IS NULL OR run.query_set_id = ${input.query_set_id ?? null}::uuid)
          AND (${input.engine_code ?? null}::varchar IS NULL OR run.engine_code = ${input.engine_code ?? null})
          AND (${input.status ?? null}::varchar IS NULL OR run.status = ${input.status ?? null})
          AND has_project_scope_access(
            run.tenant_id, run.workspace_id, run.project_id, ${scope.userId}::uuid
          )
        ORDER BY run.created_at DESC, run.id
        LIMIT ${input.limit}
      `;
      return Object.freeze(rows.map(toRunSummary));
    });
  }

  public async getRun(
    scope: AnalyticsApiScope,
    workspaceId: string,
    id: string,
  ): Promise<AiVisibilityRunDetail> {
    return resolveClient(this.database).begin(async (transaction) => {
      const rows = await transaction<RunRow[]>`
        SELECT
          run.id, run.workspace_id AS "workspaceId", run.project_id AS "projectId",
          run.query_set_id AS "querySetId", run.baseline_run_id AS "baselineRunId",
          run.engine_code AS "engineCode", run.model_key AS "modelKey",
          run.retrieval_mode AS "retrievalMode", run.status,
          run.methodology_version AS "methodologyVersion",
          run.scoring_version AS "scoringVersion", run.query_count AS "queryCount",
          run.completed_count AS "completedCount", run.failed_count AS "failedCount",
          run.score, run.metrics_json AS metrics, run.competitors_json AS competitors,
          run.sources_json AS sources, run.opportunities_json AS opportunities,
          run.error_json AS error, run.requested_by AS "requestedBy",
          run.started_at AS "startedAt", run.finished_at AS "finishedAt", run.version,
          run.created_at AS "createdAt", run.updated_at AS "updatedAt"
        FROM ai_visibility_runs AS run
        WHERE run.id = ${id}::uuid
          AND run.tenant_id = ${scope.tenantId}::uuid
          AND run.workspace_id = ${workspaceId}::uuid
          AND has_project_scope_access(
            run.tenant_id, run.workspace_id, run.project_id, ${scope.userId}::uuid
          )
        LIMIT 1
      `;
      const run = rows[0];
      if (!run) throw new AiVisibilityStateError();
      const querySet = await selectQuerySet(transaction, scope, workspaceId, run.querySetId);
      const queries = await selectQueries(transaction, scope.tenantId, querySet.id);
      const queryMap = new Map(queries.map((query) => [query.id, toQueryView(query)]));
      const responses = await transaction<ResponseRow[]>`
        SELECT
          response.id, response.query_id AS "queryId",
          response.answer_text AS "answerText", response.response_hash AS "responseHash",
          response.target_mentioned AS "targetMentioned", response.target_rank AS "targetRank",
          response.recommended, response.sentiment,
          response.recognition_status AS "recognitionStatus",
          response.competitors_json AS competitors, response.citations_json AS citations,
          response.provider_request_id AS "providerRequestId", response.usage_json AS usage,
          response.error_json AS error, response.observed_at AS "observedAt"
        FROM ai_visibility_responses AS response
        WHERE response.tenant_id = ${scope.tenantId}::uuid
          AND response.run_id = ${id}::uuid
        ORDER BY response.created_at, response.id
      `;
      return Object.freeze({
        ...toRunSummary(run),
        query_set: toQuerySetView(querySet, queries),
        responses: responses.map((response) => {
          const query = queryMap.get(response.queryId);
          if (!query) throw new AiVisibilityStateError();
          return Object.freeze({
            answer_text: response.answerText,
            citations: jsonArray<AiVisibilityRunDetail['responses'][number]['citations'][number]>(
              response.citations,
            ),
            competitors_mentioned: stringArray(response.competitors),
            error_json: response.error,
            id: response.id,
            observed_at: response.observedAt.toISOString(),
            provider_request_id: response.providerRequestId,
            query,
            recommended: response.recommended,
            recognition_status: response.recognitionStatus,
            response_hash: response.responseHash,
            sentiment: response.sentiment,
            target_mentioned: response.targetMentioned,
            target_rank: response.targetRank,
            usage: jsonObjectOrNull(response.usage),
          });
        }),
      });
    });
  }
}

export class AiVisibilityValidationError extends Error {}
export class AiVisibilityStateError extends Error {}

function defaultQueries(input: {
  readonly brandName: string;
  readonly competitors: readonly string[];
  readonly industry: string;
  readonly market: string | null;
}): readonly {
  readonly commercial_value: 'high' | 'low' | 'medium';
  readonly intent_code: QueryRow['intentCode'];
  readonly query_text: string;
}[] {
  const area = input.market ? `${input.market}的` : '';
  const category = `${area}${input.industry}`;
  const [competitorA, competitorB] = input.competitors;
  return [
    ...questions('brand_recognition', 'medium', [
      `你了解${input.brandName}吗？请介绍它主要提供什么服务。`,
      `${input.brandName}在${input.industry}领域的特点是什么？`,
      `哪些用户可能适合选择${input.brandName}？`,
      `评价${input.brandName}时应该关注哪些优势和局限？`,
      `选择${input.brandName}之前需要核实哪些信息？`,
    ]),
    ...questions('exploration', 'medium', [
      `选择${category}服务商时最重要的判断标准是什么？`,
      `${category}服务通常包含哪些流程？`,
      `${category}有哪些常见风险和避坑方法？`,
      `如何判断一家${input.industry}服务商是否可靠？`,
      `比较${category}服务商时应该准备哪些问题？`,
    ]),
    ...questions('recommendation', 'high', [
      `请推荐几家值得了解的${category}服务商，并说明理由。`,
      `${category}有哪些口碑和服务能力值得比较的品牌？`,
      `第一次购买${input.industry}服务，优先了解哪些公司？`,
      `重视稳定交付时，可以考虑哪些${category}服务商？`,
      `重视正规团队时，有哪些${category}服务商值得咨询？`,
    ]),
    ...questions('comparison', 'high', [
      `${competitorA}和${competitorB}在${input.industry}服务上有什么区别？`,
      `${competitorA}和${competitorB}分别适合什么需求？`,
      `选择${category}服务商时，应该如何横向比较候选公司？`,
      `比较${category}头部服务商时，服务能力差异主要在哪里？`,
      `同类${input.industry}报价差异较大时应该如何选择？`,
    ]),
    ...questions('education', 'low', [
      `${input.industry}的标准服务流程是什么？`,
      `${input.industry}报价通常由哪些因素组成？`,
      `签订${input.industry}服务协议时要注意什么？`,
      `如何验收${input.industry}服务质量？`,
      `${input.industry}出现争议时应该保留哪些证据？`,
    ]),
    ...questions('procurement', 'high', [
      `企业采购${category}服务应如何制定需求清单？`,
      `采购${input.industry}服务时如何评估团队规模和履约能力？`,
      `${category}供应商准入应该核验哪些材料？`,
      `如何设计${input.industry}服务商的比选评分表？`,
      `采购${input.industry}服务时如何控制质量和交付风险？`,
    ]),
  ];
}

function questions(
  intentCode: QueryRow['intentCode'],
  commercialValue: 'high' | 'low' | 'medium',
  values: readonly string[],
) {
  return values.map((queryText) => ({
    commercial_value: commercialValue,
    intent_code: intentCode,
    query_text: queryText,
  }));
}

function normalizeQueries(
  input: readonly {
    readonly commercial_value: 'high' | 'low' | 'medium';
    readonly intent_code: QueryRow['intentCode'];
    readonly query_text: string;
  }[],
  brand: {
    readonly aliases: readonly string[];
    readonly brandName: string;
  },
): readonly NormalizedQuery[] {
  const seen = new Set<string>();
  const intents = new Set<QueryRow['intentCode']>();
  const normalized = input.map((query, index) => {
    const queryText = normalizeText(query.query_text);
    const queryHash = createHash('sha256')
      .update(queryText.toLocaleLowerCase('zh-CN'))
      .digest('hex');
    if (!queryText || seen.has(queryHash)) throw new AiVisibilityValidationError();
    const names = [brand.brandName, ...brand.aliases];
    const containsBrand = names.some((name) => includesNormalized(queryText, name));
    if (query.intent_code === 'brand_recognition' ? !containsBrand : containsBrand) {
      throw new AiVisibilityValidationError();
    }
    seen.add(queryHash);
    intents.add(query.intent_code);
    return Object.freeze({
      commercialValue: query.commercial_value,
      intentCode: query.intent_code,
      queryHash,
      queryKey: `q${String(index + 1).padStart(3, '0')}`,
      queryText,
      sortOrder: index + 1,
    });
  });
  if (intents.size !== 6) throw new AiVisibilityValidationError();
  return Object.freeze(normalized);
}

function includesNormalized(value: string, search: string): boolean {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .includes(search.normalize('NFKC').toLocaleLowerCase('zh-CN'));
}

function uniqueNames(values: readonly string[], brandName: string, excludeBrand = true): string[] {
  const brandKey = normalizeText(brandName).toLocaleLowerCase('zh-CN');
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const name = normalizeText(value);
    const key = name.toLocaleLowerCase('zh-CN');
    if (!name || seen.has(key) || (excludeBrand && key === brandKey)) continue;
    seen.add(key);
    normalized.push(name);
  }
  return normalized;
}

async function selectQuerySet(
  transaction: TransactionSql,
  scope: AnalyticsApiScope,
  workspaceId: string,
  id: string,
): Promise<QuerySetRow> {
  const rows = await transaction<QuerySetRow[]>`
    SELECT
      query_set.id, query_set.workspace_id AS "workspaceId",
      query_set.project_id AS "projectId", query_set.series_id AS "seriesId",
      query_set.revision, query_set.name, query_set.brand_name AS "brandName",
      query_set.brand_aliases_json AS "brandAliases", query_set.industry,
      query_set.market, query_set.positioning,
      query_set.competitor_names_json AS "competitorNames", query_set.locale,
      query_set.status, query_set.methodology_version AS "methodologyVersion",
      query_set.created_by AS "createdBy", query_set.created_at AS "createdAt",
      query_set.updated_at AS "updatedAt"
    FROM ai_visibility_query_sets AS query_set
    WHERE query_set.id = ${id}::uuid
      AND query_set.tenant_id = ${scope.tenantId}::uuid
      AND query_set.workspace_id = ${workspaceId}::uuid
      AND has_project_scope_access(
        query_set.tenant_id, query_set.workspace_id, query_set.project_id,
        ${scope.userId}::uuid
      )
    LIMIT 1
  `;
  if (!rows[0]) throw new AiVisibilityStateError();
  return rows[0];
}

async function selectQueries(
  transaction: TransactionSql,
  tenantId: string,
  querySetId: string,
): Promise<readonly QueryRow[]> {
  const rows = await transaction<QueryRow[]>`
    SELECT
      id, query_key AS "queryKey", intent_code AS "intentCode",
      query_text AS "queryText", query_hash AS "queryHash",
      commercial_value AS "commercialValue", sort_order AS "sortOrder",
      created_at AS "createdAt"
    FROM ai_visibility_queries
    WHERE tenant_id = ${tenantId}::uuid AND query_set_id = ${querySetId}::uuid
    ORDER BY sort_order, id
  `;
  return Object.freeze(rows);
}

async function assertBaseline(
  transaction: TransactionSql,
  scope: AnalyticsApiScope,
  baselineRunId: string,
  querySetId: string,
  engineCode: string,
): Promise<void> {
  const rows = await transaction<{ valid: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM ai_visibility_runs
      WHERE id = ${baselineRunId}::uuid
        AND tenant_id = ${scope.tenantId}::uuid
        AND query_set_id = ${querySetId}::uuid
        AND engine_code = ${engineCode}
        AND status IN ('succeeded', 'partial')
    ) AS valid
  `;
  if (!rows[0]?.valid) throw new AiVisibilityValidationError();
}

async function assertProjectAccess(
  transaction: TransactionSql,
  scope: AnalyticsApiScope,
  workspaceId: string,
  projectId: string,
): Promise<void> {
  const rows = await transaction<{ allowed: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM projects AS project
      JOIN workspaces AS workspace
        ON workspace.id = project.workspace_id AND workspace.tenant_id = project.tenant_id
      JOIN memberships AS membership ON membership.tenant_id = project.tenant_id
      JOIN users AS identity_user ON identity_user.id = membership.user_id
      WHERE project.id = ${projectId}::uuid
        AND project.tenant_id = ${scope.tenantId}::uuid
        AND project.workspace_id = ${workspaceId}::uuid
        AND project.status = 'active' AND project.deleted_at IS NULL
        AND workspace.status = 'active' AND workspace.deleted_at IS NULL
        AND membership.user_id = ${scope.userId}::uuid
        AND membership.status = 'active'
        AND membership.role_code IN ('tenant_owner', 'tenant_admin', 'analyst')
        AND identity_user.status = 'active'
        AND has_project_scope_access(
          project.tenant_id, project.workspace_id, project.id, membership.user_id
        )
    ) AS allowed
  `;
  if (!rows[0]?.allowed) throw new AiVisibilityStateError();
}

async function assertWorkspaceAccess(
  transaction: TransactionSql,
  scope: AnalyticsApiScope,
  workspaceId: string,
): Promise<void> {
  const rows = await transaction<{ allowed: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM workspaces AS workspace
      JOIN memberships AS membership ON membership.tenant_id = workspace.tenant_id
      JOIN users AS identity_user ON identity_user.id = membership.user_id
      WHERE workspace.id = ${workspaceId}::uuid
        AND workspace.tenant_id = ${scope.tenantId}::uuid
        AND workspace.status = 'active' AND workspace.deleted_at IS NULL
        AND membership.user_id = ${scope.userId}::uuid
        AND membership.status = 'active'
        AND membership.role_code IN ('tenant_owner', 'tenant_admin', 'analyst')
        AND identity_user.status = 'active'
        AND has_project_scope_access(
          workspace.tenant_id, workspace.id, NULL, membership.user_id
        )
    ) AS allowed
  `;
  if (!rows[0]?.allowed) throw new AiVisibilityStateError();
}

function toQuerySetView(row: QuerySetRow, queries: readonly QueryRow[]): AiVisibilityQuerySetView {
  return Object.freeze({
    brand_aliases: stringArray(row.brandAliases),
    brand_name: row.brandName,
    competitor_names: stringArray(row.competitorNames),
    created_at: row.createdAt.toISOString(),
    created_by: row.createdBy,
    id: row.id,
    industry: row.industry,
    locale: row.locale,
    market: row.market,
    methodology_version: row.methodologyVersion,
    name: row.name,
    positioning: row.positioning,
    project_id: row.projectId,
    queries: queries.map(toQueryView),
    query_count: queries.length,
    revision: row.revision,
    series_id: row.seriesId,
    status: row.status,
    updated_at: row.updatedAt.toISOString(),
    workspace_id: row.workspaceId,
  });
}

function toQueryView(row: QueryRow) {
  return Object.freeze({
    commercial_value: row.commercialValue,
    created_at: row.createdAt.toISOString(),
    id: row.id,
    intent_code: row.intentCode,
    query_hash: row.queryHash,
    query_key: row.queryKey,
    query_text: row.queryText,
    sort_order: row.sortOrder,
  });
}

function toRunSummary(row: RunRow): AiVisibilityRunSummary {
  const metrics = jsonObjectOrNull(row.metrics);
  const score = row.score === null ? null : Number(row.score);
  return Object.freeze({
    baseline_run_id: row.baselineRunId,
    completed_count: row.completedCount,
    competitors: jsonArray<AiVisibilityRunSummary['competitors'][number]>(row.competitors),
    created_at: row.createdAt.toISOString(),
    engine_code: row.engineCode,
    error_json: row.error,
    failed_count: row.failedCount,
    finished_at: row.finishedAt?.toISOString() ?? null,
    id: row.id,
    methodology_version: row.methodologyVersion,
    metrics: score === null ? null : (metrics as AiVisibilityRunSummary['metrics']),
    model_key: row.modelKey,
    opportunities: jsonArray<AiVisibilityRunSummary['opportunities'][number]>(row.opportunities),
    project_id: row.projectId,
    query_count: row.queryCount,
    query_set_id: row.querySetId,
    requested_by: row.requestedBy,
    retrieval_mode: row.retrievalMode,
    score,
    scoring_version: row.scoringVersion,
    sources: jsonArray<AiVisibilityRunSummary['sources'][number]>(row.sources),
    started_at: row.startedAt?.toISOString() ?? null,
    status: row.status,
    updated_at: row.updatedAt.toISOString(),
    version: row.version,
    workspace_id: row.workspaceId,
  });
}

async function audit(
  transaction: TransactionSql,
  scope: AnalyticsApiScope,
  action: string,
  resourceType: string,
  resourceId: string,
  after: Readonly<Record<string, unknown>>,
): Promise<void> {
  await transaction`
    INSERT INTO audit_events (
      tenant_id, actor_id, action, resource_type, resource_id, after_json, request_id
    ) VALUES (
      ${scope.tenantId}::uuid, ${scope.userId}::uuid, ${action}, ${resourceType},
      ${resourceId}::uuid, ${JSON.stringify(after)}::text::jsonb, ${scope.requestId}
    )
  `;
}

function visibilityModelKey(): string {
  return (
    process.env['VISIBILITY_MODEL_KEY'] ??
    process.env['CONTENT_MODEL_BALANCED_KEY'] ??
    'deepseek-v4-flash'
  );
}

function jsonArray<Item>(value: unknown): Item[] {
  return Array.isArray(value) ? (value as Item[]) : [];
}

function jsonObjectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function resolveClient(database: DatabaseClient | AiVisibilityDatabaseProvider): DatabaseClient {
  return typeof database === 'function' ? database : database.client;
}
