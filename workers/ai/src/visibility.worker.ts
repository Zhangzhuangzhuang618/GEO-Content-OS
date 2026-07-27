import type { ModelAdapter, ModelUsage } from '@geo-content-os/adapter-model';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';

import { validateVisibilityProbeEvent } from './visibility.event.js';

interface RunRow {
  readonly brandAliases: unknown;
  readonly brandName: string;
  readonly competitorNames: unknown;
  readonly engineCode: string;
  readonly id: string;
  readonly industry: string;
  readonly market: string | null;
  readonly methodologyVersion: string;
  readonly modelKey: string;
  readonly positioning: string | null;
  readonly projectId: string;
  readonly queryCount: number;
  readonly querySetId: string;
  readonly requestedBy: string;
  readonly scoringVersion: string;
  readonly status: string;
  readonly workspaceId: string;
}

interface QueryRow {
  readonly commercialValue: 'high' | 'low' | 'medium';
  readonly id: string;
  readonly intentCode:
    | 'brand_recognition'
    | 'comparison'
    | 'education'
    | 'exploration'
    | 'procurement'
    | 'recommendation';
  readonly queryKey: string;
  readonly queryText: string;
}

interface Analysis {
  readonly citations: readonly Citation[];
  readonly competitorsMentioned: readonly string[];
  readonly recommended: boolean;
  readonly recognitionStatus: RecognitionStatus;
  readonly sentiment: 'negative' | 'neutral' | 'positive' | 'unknown';
  readonly targetMentioned: boolean;
  readonly targetRank: number | null;
}

type RecognitionStatus =
  'misidentified' | 'not_applicable' | 'not_recognized' | 'recognized' | 'uncertain';

interface Citation {
  readonly domain: string;
  readonly title: null;
  readonly url: string;
}

interface ResultRow extends QueryRow {
  readonly answerText: string | null;
  readonly citations: unknown;
  readonly competitors: unknown;
  readonly error: Readonly<Record<string, unknown>> | null;
  readonly recommended: boolean;
  readonly recognitionStatus: RecognitionStatus;
  readonly sentiment: Analysis['sentiment'];
  readonly targetMentioned: boolean;
  readonly targetRank: number | null;
}

export interface VisibilityProbeResult {
  readonly disposition: 'completed' | 'ignored';
  readonly runId: string;
  readonly status: 'failed' | 'partial' | 'succeeded';
}

export class VisibilityProbeWorker {
  public constructor(
    private readonly client: postgres.Sql,
    private readonly adapters: ReadonlyMap<string, ModelAdapter>,
  ) {}

  public async run(raw: unknown): Promise<VisibilityProbeResult> {
    const event = validateVisibilityProbeEvent(raw);
    const claim = await this.claim(event.tenantId, event.data.runId);
    if (!claim) {
      return Object.freeze({ disposition: 'ignored', runId: event.data.runId, status: 'failed' });
    }
    const adapter = this.adapters.get(claim.modelKey);
    if (!adapter) {
      await this.failRun(event.tenantId, claim.id, 'MODEL_ROUTE_NOT_FOUND');
      throw new Error(`AI Worker has no adapter for visibility model ${claim.modelKey}`);
    }
    const aliases = stringArray(claim.brandAliases);
    const competitors = stringArray(claim.competitorNames);
    const queries = await this.loadQueries(event.tenantId, claim.querySetId);
    for (const query of queries) {
      if (await this.hasResponse(event.tenantId, claim.id, query.id)) continue;
      try {
        const result = await adapter.generate({
          maxOutputTokens: 3_000,
          messages: [
            {
              content:
                '你正在参与一项可重复的 AI 回答基准测试。请只根据问题自然、完整、客观地作答；不知道时明确说明，不要假装联网，不要添加测试说明。',
              role: 'system',
            },
            {
              content: JSON.stringify({ ai_visibility_query: { text: query.queryText } }),
              role: 'user',
            },
          ],
          requestId: `visibility:${claim.id}:${query.queryKey}`,
          responseFormat: { type: 'text' },
          temperature: 0.2,
        });
        const answer = result.message.content?.trim();
        if (!answer) throw new Error('Model returned an empty visibility answer');
        const analysis = analyzeVisibilityAnswer(answer, {
          aliases,
          brandName: claim.brandName,
          competitors,
          industry: claim.industry,
          intentCode: query.intentCode,
          market: claim.market,
          positioning: claim.positioning,
        });
        await this.insertSuccess(
          event.tenantId,
          claim.id,
          query.id,
          answer,
          analysis,
          result.usage,
        );
      } catch (error) {
        await this.insertFailure(event.tenantId, claim.id, query.id, error);
      }
      await this.refreshProgress(event.tenantId, claim.id);
    }
    return this.finalize(event.tenantId, claim);
  }

  private async claim(tenantId: string, runId: string): Promise<RunRow | null> {
    return this.client.begin(async (transaction) => {
      const rows = await transaction<RunRow[]>`
        SELECT
          run.id, run.workspace_id AS "workspaceId", run.project_id AS "projectId",
          run.query_set_id AS "querySetId", run.engine_code AS "engineCode",
          run.model_key AS "modelKey", run.status, run.query_count AS "queryCount",
          run.methodology_version AS "methodologyVersion",
          run.scoring_version AS "scoringVersion", run.requested_by AS "requestedBy",
          query_set.brand_name AS "brandName",
          query_set.brand_aliases_json AS "brandAliases",
          query_set.competitor_names_json AS "competitorNames",
          query_set.industry, query_set.market, query_set.positioning
        FROM ai_visibility_runs AS run
        JOIN ai_visibility_query_sets AS query_set
          ON query_set.id = run.query_set_id AND query_set.tenant_id = run.tenant_id
        WHERE run.id = ${runId}::uuid AND run.tenant_id = ${tenantId}::uuid
        FOR UPDATE OF run
      `;
      const row = rows[0];
      if (!row || ['succeeded', 'partial', 'failed', 'cancelled'].includes(row.status)) return null;
      if (!['queued', 'running'].includes(row.status)) return null;
      await transaction`
        UPDATE ai_visibility_runs
        SET status = 'running', started_at = COALESCE(started_at, now()), version = version + 1
        WHERE id = ${runId}::uuid AND tenant_id = ${tenantId}::uuid
      `;
      return Object.freeze({ ...row, status: 'running' });
    });
  }

  private async loadQueries(tenantId: string, querySetId: string): Promise<readonly QueryRow[]> {
    const rows = await this.client<QueryRow[]>`
      SELECT
        id, query_key AS "queryKey", intent_code AS "intentCode",
        query_text AS "queryText", commercial_value AS "commercialValue"
      FROM ai_visibility_queries
      WHERE tenant_id = ${tenantId}::uuid AND query_set_id = ${querySetId}::uuid
      ORDER BY sort_order, id
    `;
    return Object.freeze(rows);
  }

  private async hasResponse(tenantId: string, runId: string, queryId: string): Promise<boolean> {
    const rows = await this.client<{ found: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM ai_visibility_responses
        WHERE tenant_id = ${tenantId}::uuid
          AND run_id = ${runId}::uuid
          AND query_id = ${queryId}::uuid
          AND sample_index = 1
      ) AS found
    `;
    return rows[0]?.found ?? false;
  }

  private async insertSuccess(
    tenantId: string,
    runId: string,
    queryId: string,
    answer: string,
    analysis: Analysis,
    usage: ModelUsage,
  ): Promise<void> {
    const responseHash = createHash('sha256').update(answer).digest('hex');
    await this.client`
      INSERT INTO ai_visibility_responses (
        tenant_id, run_id, query_id, answer_text, response_hash,
        target_mentioned, target_rank, recommended, sentiment,
        recognition_status, competitors_json, citations_json, provider_request_id, usage_json
      ) VALUES (
        ${tenantId}::uuid, ${runId}::uuid, ${queryId}::uuid, ${answer}, ${responseHash},
        ${analysis.targetMentioned}, ${analysis.targetRank}, ${analysis.recommended},
        ${analysis.sentiment}, ${analysis.recognitionStatus},
        ${JSON.stringify(analysis.competitorsMentioned)}::text::jsonb,
        ${JSON.stringify(analysis.citations)}::text::jsonb, ${usage.providerRequestId},
        ${JSON.stringify(usage)}::text::jsonb
      )
      ON CONFLICT (tenant_id, run_id, query_id, sample_index) DO NOTHING
    `;
  }

  private async insertFailure(
    tenantId: string,
    runId: string,
    queryId: string,
    error: unknown,
  ): Promise<void> {
    await this.client`
      INSERT INTO ai_visibility_responses (
        tenant_id, run_id, query_id, answer_text, target_mentioned,
        recommended, sentiment, competitors_json, citations_json, error_json
      ) VALUES (
        ${tenantId}::uuid, ${runId}::uuid, ${queryId}::uuid, NULL, false,
        false, 'unknown', '[]'::jsonb, '[]'::jsonb,
        ${JSON.stringify({ code: errorCode(error), message: safeMessage(error) })}::text::jsonb
      )
      ON CONFLICT (tenant_id, run_id, query_id, sample_index) DO NOTHING
    `;
  }

  private async refreshProgress(tenantId: string, runId: string): Promise<void> {
    await this.client`
      UPDATE ai_visibility_runs AS run
      SET
        completed_count = progress.completed_count,
        failed_count = progress.failed_count,
        version = run.version + 1
      FROM (
        SELECT
          count(*) FILTER (WHERE answer_text IS NOT NULL)::integer AS completed_count,
          count(*) FILTER (WHERE error_json IS NOT NULL)::integer AS failed_count
        FROM ai_visibility_responses
        WHERE tenant_id = ${tenantId}::uuid AND run_id = ${runId}::uuid
      ) AS progress
      WHERE run.id = ${runId}::uuid AND run.tenant_id = ${tenantId}::uuid
    `;
  }

  private async finalize(tenantId: string, run: RunRow): Promise<VisibilityProbeResult> {
    const rows = await this.client<ResultRow[]>`
      SELECT
        query.id, query.query_key AS "queryKey", query.intent_code AS "intentCode",
        query.query_text AS "queryText", query.commercial_value AS "commercialValue",
        response.answer_text AS "answerText", response.target_mentioned AS "targetMentioned",
        response.target_rank AS "targetRank", response.recommended, response.sentiment,
        response.recognition_status AS "recognitionStatus",
        response.competitors_json AS competitors, response.citations_json AS citations,
        response.error_json AS error
      FROM ai_visibility_queries AS query
      LEFT JOIN ai_visibility_responses AS response
        ON response.query_id = query.id AND response.tenant_id = query.tenant_id
        AND response.run_id = ${run.id}::uuid AND response.sample_index = 1
      WHERE query.tenant_id = ${tenantId}::uuid AND query.query_set_id = ${run.querySetId}::uuid
      ORDER BY query.sort_order, query.id
    `;
    const report = scoreVisibility(rows, stringArray(run.competitorNames));
    const failedCount = rows.filter((row) => row.error !== null || row.answerText === null).length;
    const completedCount = rows.length - failedCount;
    const status = completedCount === 0 ? 'failed' : failedCount === 0 ? 'succeeded' : 'partial';
    const error =
      failedCount === 0
        ? null
        : { failed_queries: failedCount, schema_version: 'ai-visibility-error@1' };
    await this.client.begin(async (transaction) => {
      await transaction`
        UPDATE ai_visibility_runs
        SET
          status = ${status}, completed_count = ${completedCount}, failed_count = ${failedCount},
          score = ${completedCount === 0 ? null : report.metrics.score},
          metrics_json = ${JSON.stringify(completedCount === 0 ? {} : report.metrics)}::text::jsonb,
          competitors_json = ${JSON.stringify(report.competitors)}::text::jsonb,
          sources_json = ${JSON.stringify(report.sources)}::text::jsonb,
          opportunities_json = ${JSON.stringify(report.opportunities)}::text::jsonb,
          error_json = ${error === null ? null : JSON.stringify(error)}::text::jsonb,
          finished_at = now(), version = version + 1
        WHERE id = ${run.id}::uuid AND tenant_id = ${tenantId}::uuid
      `;
      await transaction`
        INSERT INTO audit_events (
          tenant_id, actor_id, action, resource_type, resource_id, after_json, request_id
        ) VALUES (
          ${tenantId}::uuid, ${run.requestedBy}::uuid, 'ai_visibility.run.completed',
          'ai_visibility_run', ${run.id}::uuid,
          ${JSON.stringify({
            completed_count: completedCount,
            failed_count: failedCount,
            score: completedCount === 0 ? null : report.metrics.score,
            scoring_version: run.scoringVersion,
            status,
          })}::text::jsonb,
          ${`visibility:${run.id}`}
        )
      `;
    });
    return Object.freeze({ disposition: 'completed', runId: run.id, status });
  }

  private async failRun(tenantId: string, runId: string, code: string): Promise<void> {
    await this.client`
      UPDATE ai_visibility_runs
      SET status = 'failed', error_json = ${JSON.stringify({ code })}::text::jsonb,
          finished_at = now(), version = version + 1
      WHERE id = ${runId}::uuid AND tenant_id = ${tenantId}::uuid
        AND status IN ('queued', 'running')
    `;
  }
}

export function analyzeVisibilityAnswer(
  answer: string,
  input: {
    readonly aliases: readonly string[];
    readonly brandName: string;
    readonly competitors: readonly string[];
    readonly industry: string;
    readonly intentCode: QueryRow['intentCode'];
    readonly market: string | null;
    readonly positioning: string | null;
  },
): Analysis {
  const targetNames = [input.brandName, ...input.aliases];
  const targetIndex = firstNameIndex(answer, targetNames);
  const competitorIndexes = input.competitors
    .map((name) => ({ index: firstNameIndex(answer, [name]), name }))
    .filter((item) => item.index >= 0);
  const targetRank =
    targetIndex < 0 || !COMMERCIAL_INTENTS.has(input.intentCode)
      ? null
      : extractExplicitRank(answer, targetNames);
  const context =
    targetIndex < 0 ? '' : answer.slice(Math.max(0, targetIndex - 80), targetIndex + 160);
  const negative = /(不推荐|不可靠|投诉|严重问题|风险较高|谨慎选择|较差|不足)/u.test(context);
  const positive = /(推荐|值得|可靠|正规|专业|稳定|优势|良好|可以考虑)/u.test(context);
  const sentiment =
    targetIndex < 0 ? 'unknown' : negative ? 'negative' : positive ? 'positive' : 'neutral';
  return Object.freeze({
    citations: extractCitations(answer),
    competitorsMentioned: Object.freeze(competitorIndexes.map((item) => item.name)),
    recommended:
      targetIndex >= 0 && !negative && positive && COMMERCIAL_INTENTS.has(input.intentCode),
    recognitionStatus: classifyRecognition(answer, {
      ...input,
      targetNames,
    }),
    sentiment,
    targetMentioned: targetIndex >= 0,
    targetRank,
  });
}

export function scoreVisibility(rows: readonly ResultRow[], competitorNames: readonly string[]) {
  const answered = rows.filter((row) => row.answerText !== null);
  const naturalAnswered = answered.filter((row) => NATURAL_INTENTS.has(row.intentCode));
  const naturallyMentioned = naturalAnswered.filter((row) => row.targetMentioned);
  const mentioned = answered.filter((row) => row.targetMentioned);
  const recognition = answered.filter((row) => row.intentCode === 'brand_recognition');
  const commercial = answered.filter((row) => COMMERCIAL_INTENTS.has(row.intentCode));
  const ranks = commercial
    .map((row) => row.targetRank)
    .filter((value): value is number => value !== null);
  const averageRank = ranks.length === 0 ? null : average(ranks);
  const rankScore = averageRank === null ? 0 : Math.max(0, 1 - (averageRank - 1) / 9);
  const mentionRate = rate(naturallyMentioned.length, naturalAnswered.length);
  const recognitionRate = rate(
    recognition.filter((row) => row.recognitionStatus === 'recognized').length,
    recognition.length,
  );
  const recommendationRate = rate(
    commercial.filter((row) => row.recommended).length,
    commercial.length,
  );
  const positiveSentimentRate = rate(
    mentioned.filter((row) => row.sentiment === 'positive').length,
    mentioned.length,
  );
  const score = round(
    mentionRate * 40 + recognitionRate * 30 + rankScore * 20 + positiveSentimentRate * 10,
  );
  const competitors = competitorNames
    .map((name) => {
      const count = answered.filter((row) => stringArray(row.competitors).includes(name)).length;
      return {
        average_rank: null,
        mention_count: count,
        mention_rate: rate(count, answered.length),
        name,
      };
    })
    .sort(
      (left, right) =>
        right.mention_count - left.mention_count || left.name.localeCompare(right.name),
    );
  const urlCounts = new Map<
    string,
    {
      domain: string;
      intents: Set<QueryRow['intentCode']>;
      mentionCount: number;
      queries: Set<string>;
      url: string;
    }
  >();
  const domainCounts = new Map<
    string,
    {
      intents: Set<QueryRow['intentCode']>;
      mentionCount: number;
      queries: Set<string>;
    }
  >();
  for (const row of answered) {
    for (const citation of citationArray(row.citations)) {
      const existingUrl = urlCounts.get(citation.url);
      urlCounts.set(citation.url, {
        domain: citation.domain,
        intents: new Set([...(existingUrl?.intents ?? []), row.intentCode]),
        mentionCount: (existingUrl?.mentionCount ?? 0) + 1,
        queries: new Set([...(existingUrl?.queries ?? []), row.id]),
        url: citation.url,
      });
      const existingDomain = domainCounts.get(citation.domain);
      domainCounts.set(citation.domain, {
        intents: new Set([...(existingDomain?.intents ?? []), row.intentCode]),
        mentionCount: (existingDomain?.mentionCount ?? 0) + 1,
        queries: new Set([...(existingDomain?.queries ?? []), row.id]),
      });
    }
  }
  const sources = [
    ...[...domainCounts.entries()].map(([domain, source]) => ({
      domain,
      intent_codes: [...source.intents].sort(),
      level: 'domain' as const,
      mention_count: source.mentionCount,
      query_count: source.queries.size,
      url: null,
    })),
    ...[...urlCounts.values()].map((source) => ({
      domain: source.domain,
      intent_codes: [...source.intents].sort(),
      level: 'url' as const,
      mention_count: source.mentionCount,
      query_count: source.queries.size,
      url: source.url,
    })),
  ].sort(
    (left, right) =>
      left.level.localeCompare(right.level) ||
      right.mention_count - left.mention_count ||
      left.domain.localeCompare(right.domain) ||
      String(left.url).localeCompare(String(right.url)),
  );
  const opportunities = answered
    .filter(
      (row) =>
        !row.targetMentioned &&
        row.commercialValue === 'high' &&
        COMMERCIAL_INTENTS.has(row.intentCode) &&
        stringArray(row.competitors).length > 0,
    )
    .map((row) => ({
      commercial_value: row.commercialValue,
      competitors_mentioned: stringArray(row.competitors),
      intent_code: row.intentCode,
      query_id: row.id,
      query_key: row.queryKey,
      query_text: row.queryText,
    }));
  return Object.freeze({
    competitors: Object.freeze(competitors),
    metrics: Object.freeze({
      answered_count: answered.length,
      average_rank: averageRank === null ? null : round(averageRank),
      mention_rate: round(mentionRate, 4),
      misidentified_count: recognition.filter((row) => row.recognitionStatus === 'misidentified')
        .length,
      natural_answered_count: naturalAnswered.length,
      positive_sentiment_rate: round(positiveSentimentRate, 4),
      rank_score: round(rankScore, 4),
      ranked_count: ranks.length,
      recognized_count: recognition.filter((row) => row.recognitionStatus === 'recognized').length,
      recognition_rate: round(recognitionRate, 4),
      recommendation_rate: round(recommendationRate, 4),
      score,
      total_count: rows.length,
    }),
    opportunities: Object.freeze(opportunities),
    sources: Object.freeze(sources),
  });
}

const COMMERCIAL_INTENTS = new Set<QueryRow['intentCode']>([
  'comparison',
  'procurement',
  'recommendation',
]);

const NATURAL_INTENTS = new Set<QueryRow['intentCode']>([
  'education',
  'exploration',
  'procurement',
  'recommendation',
]);

function classifyRecognition(
  answer: string,
  input: {
    readonly competitors: readonly string[];
    readonly industry: string;
    readonly intentCode: QueryRow['intentCode'];
    readonly market: string | null;
    readonly positioning: string | null;
    readonly targetNames: readonly string[];
  },
): RecognitionStatus {
  if (input.intentCode !== 'brand_recognition') return 'not_applicable';
  const normalized = normalize(answer);
  if (firstNameIndex(answer, input.targetNames) < 0) return 'not_recognized';
  if (isStrongMisidentification(normalized, input.targetNames, input.competitors)) {
    return 'misidentified';
  }
  const targetContext = targetContexts(normalized, input.targetNames).join(' ');
  if (
    /(不了解|不清楚|无法确认|无法核实|未找到|没有足够信息|不确定|可能是|似乎是)/u.test(
      targetContext,
    )
  ) {
    return 'uncertain';
  }
  const anchors = [
    input.industry,
    input.market,
    ...(input.positioning?.split(/[，。；、,.;：:\s]+/u) ?? []),
  ]
    .filter((value): value is string => Boolean(value && value.trim().length >= 2))
    .map(normalize);
  if (
    anchors.some((anchor) => normalized.includes(anchor)) ||
    /(提供|主营|服务|业务|公司|企业|品牌|团队|机构)/u.test(targetContext)
  ) {
    return 'recognized';
  }
  return 'uncertain';
}

function isStrongMisidentification(
  normalizedAnswer: string,
  targetNames: readonly string[],
  competitors: readonly string[],
): boolean {
  for (const target of targetNames.map(normalize)) {
    for (const competitor of competitors.map(normalize)) {
      const left = `${escapeRegExp(target)}\\s*(?:就是|即|又称为?|是)\\s*${escapeRegExp(competitor)}`;
      const right = `${escapeRegExp(competitor)}\\s*(?:就是|即|又称为?)\\s*${escapeRegExp(target)}`;
      if (new RegExp(`(?:${left}|${right})`, 'u').test(normalizedAnswer)) return true;
    }
  }
  return false;
}

function targetContexts(normalizedAnswer: string, names: readonly string[]): string[] {
  return names.map(normalize).flatMap((name) => {
    const index = normalizedAnswer.indexOf(name);
    return index < 0
      ? []
      : [normalizedAnswer.slice(Math.max(0, index - 80), index + name.length + 160)];
  });
}

function extractExplicitRank(answer: string, targetNames: readonly string[]): number | null {
  for (const line of answer.split(/\r?\n/u)) {
    if (firstNameIndex(line, targetNames) < 0) continue;
    const rank =
      line.match(/第\s*([一二三四五六七八九十]|\d{1,2})\s*(?:名|位)/u)?.[1] ??
      line.match(/^\s*(?:[（(]\s*)?([一二三四五六七八九十]|\d{1,2})\s*[.、)）]/u)?.[1];
    const parsed = rank ? parseRank(rank) : null;
    if (parsed !== null && parsed <= 10) return parsed;
  }
  return null;
}

function parseRank(value: string): number | null {
  const numeric = Number.parseInt(value, 10);
  if (Number.isInteger(numeric) && numeric > 0) return numeric;
  return CHINESE_RANKS[value as keyof typeof CHINESE_RANKS] ?? null;
}

const CHINESE_RANKS = {
  一: 1,
  七: 7,
  三: 3,
  九: 9,
  二: 2,
  五: 5,
  八: 8,
  六: 6,
  十: 10,
  四: 4,
} as const;

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function extractCitations(answer: string): readonly Citation[] {
  const matches = answer.match(/https?:\/\/[^\s<>"'）)\]]+/giu) ?? [];
  const citations = new Map<string, Citation>();
  for (const raw of matches) {
    const value = raw.replace(/[，。；、,.!?;:]+$/u, '');
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      citations.set(url.href, Object.freeze({ domain: url.hostname, title: null, url: url.href }));
    } catch {
      // Ignore malformed links emitted by the model.
    }
  }
  return Object.freeze([...citations.values()]);
}

function firstNameIndex(answer: string, names: readonly string[]): number {
  const normalizedAnswer = answer.normalize('NFKC').toLocaleLowerCase('zh-CN');
  const indexes = names
    .map((name) => normalizedAnswer.indexOf(name.normalize('NFKC').toLocaleLowerCase('zh-CN')))
    .filter((index) => index >= 0);
  return indexes.length === 0 ? -1 : Math.min(...indexes);
}

function citationArray(value: unknown): Citation[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Citation =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { domain?: unknown }).domain === 'string' &&
      typeof (item as { url?: unknown }).url === 'string',
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function errorCode(error: unknown): string {
  return error instanceof Error && error.name ? error.name.slice(0, 80) : 'VISIBILITY_QUERY_FAILED';
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'AI visibility query failed';
}
