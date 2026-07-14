import { TopicPlannerDataSchema } from '@geo-content-os/contracts';
import type {
  AdoptTopicRequest,
  BriefView,
  GenerationRunView,
  TopicBriefSuggestion,
  TopicCandidateQuery,
  TopicCandidateView,
  TopicPlanRequest,
} from '@geo-content-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';

import { canonicalJson, type JsonValue } from '../../../common/idempotency/index.js';
import { IdentityAuthDatabase } from '../../identity/auth/auth.database.js';
import { OutboxWriter } from '../../outbox/index.js';
import { readTopicPlannerConfiguration } from './topic.config.js';
import {
  TopicNotFoundError,
  TopicStateError,
  TopicValidationError,
  TopicVersionConflictError,
} from './topic.errors.js';

interface GenerationRunRow {
  readonly createdAt: Date | string;
  readonly error: Readonly<Record<string, unknown>> | null;
  readonly finishedAt: Date | string | null;
  readonly id: string;
  readonly inputHash: string;
  readonly modelKey: string;
  readonly packageId: string | null;
  readonly projectId: string | null;
  readonly promptVersionId: string;
  readonly requestId: string;
  readonly skillName: string;
  readonly skillVersion: string;
  readonly startedAt: Date | string | null;
  readonly status: GenerationRunView['status'];
  readonly tenantId: string;
  readonly updatedAt: Date | string;
  readonly variantId: string | null;
  readonly version: number;
  readonly workspaceId: string;
}

interface TopicCandidateRow {
  readonly briefSuggestion: TopicBriefSuggestion | null;
  readonly createdAt: Date | string;
  readonly cursorCreatedAt?: string;
  readonly entities: {
    readonly entities: readonly string[];
    readonly schema_version: 'entity-list@1';
  };
  readonly evidence: {
    readonly evidence_ids: readonly string[];
    readonly schema_version: 'citation-set@1';
  };
  readonly generationRunId: string;
  readonly id: string;
  readonly intent: string;
  readonly platformCodes: TopicCandidateView['platform_codes'];
  readonly priority: number;
  readonly projectId: string;
  readonly question: string;
  readonly riskLevel: TopicCandidateView['risk_level'];
  readonly status: TopicCandidateView['status'];
  readonly tenantId: string;
  readonly updatedAt: Date | string;
  readonly version: number;
  readonly workspaceId: string;
}

interface BriefRow {
  readonly audience: string;
  readonly constraints: BriefView['constraints'];
  readonly createdAt: Date | string;
  readonly createdBy: string;
  readonly dueAt: Date | string | null;
  readonly id: string;
  readonly objective: BriefView['objective'];
  readonly platformCodes: BriefView['platform_codes'];
  readonly projectId: string;
  readonly sourceTopicCandidateId: string | null;
  readonly tenantId: string;
  readonly title: string;
  readonly updatedAt: Date | string;
  readonly version: number;
  readonly workspaceId: string;
}

interface TopicCursor {
  readonly createdAt: string;
  readonly id: string;
  readonly priority: number;
}

export interface TopicAuditContext {
  readonly ip?: string;
  readonly requestId: string;
}

export interface TopicCandidatePageResult {
  readonly items: readonly TopicCandidateView[];
  readonly nextCursor: string | null;
}

@Injectable()
export class TopicService {
  private readonly configuration = readTopicPlannerConfiguration();

  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
  ) {}

  public async requestPlan(
    transaction: TransactionSql,
    tenantId: string,
    actorUserId: string,
    input: TopicPlanRequest,
    audit: TopicAuditContext,
  ): Promise<GenerationRunView> {
    await assertTopicManager(transaction, tenantId, actorUserId);
    await lockTopicProject(
      transaction,
      tenantId,
      actorUserId,
      input.workspace_id,
      input.project_id,
    );
    await assertKeywordSets(transaction, tenantId, input.project_id, input.keyword_set_ids);
    const inputHash = createHash('sha256')
      .update(canonicalJson(input as unknown as JsonValue), 'utf8')
      .digest('hex');
    const rows = await transaction<GenerationRunRow[]>`
      INSERT INTO generation_runs (
        tenant_id,
        workspace_id,
        project_id,
        skill_name,
        skill_version,
        prompt_version_id,
        model_key,
        input_hash,
        request_id
      ) VALUES (
        ${tenantId},
        ${input.workspace_id},
        ${input.project_id},
        'topic-planner',
        ${this.configuration.skillVersion},
        ${this.configuration.promptVersionId},
        ${this.configuration.modelKey},
        ${inputHash},
        ${audit.requestId}
      )
      RETURNING
        id,
        tenant_id AS "tenantId",
        workspace_id AS "workspaceId",
        project_id AS "projectId",
        package_id AS "packageId",
        variant_id AS "variantId",
        skill_name AS "skillName",
        skill_version AS "skillVersion",
        prompt_version_id AS "promptVersionId",
        model_key AS "modelKey",
        status,
        input_hash AS "inputHash",
        request_id AS "requestId",
        error_json AS error,
        started_at AS "startedAt",
        finished_at AS "finishedAt",
        version,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;
    const row = rows[0];
    if (!row) throw new Error('Topic generation run insert returned no row');
    const view = toGenerationRunView(row);
    await this.outboxWriter.enqueue(
      {
        aggregateId: row.id,
        aggregateType: 'generation_run',
        data: {
          keyword_set_ids: input.keyword_set_ids,
          max_topics: input.max_topics,
          platform_codes: input.platform_codes,
          project_id: input.project_id,
          requested_by: actorUserId,
          seed_queries: input.seed_queries,
          workspace_id: input.workspace_id,
        },
        eventType: 'strategy.topic_plan.generation_requested.v1',
        tenantId,
      },
      transaction,
    );
    await insertTopicAudit(transaction, {
      action: 'topic_plan.requested',
      actorUserId,
      after: view,
      audit,
      resourceId: row.id,
      resourceType: 'generation_run',
      tenantId,
    });
    return view;
  }

  public async list(
    tenantId: string,
    userId: string,
    query: TopicCandidateQuery,
  ): Promise<TopicCandidatePageResult> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.database.client<TopicCandidateRow[]>`
      SELECT
        topic.id,
        topic.tenant_id AS "tenantId",
        topic.workspace_id AS "workspaceId",
        topic.project_id AS "projectId",
        topic.generation_run_id AS "generationRunId",
        topic.question,
        topic.intent,
        topic.entities_json AS entities,
        topic.evidence_summary_json AS evidence,
        topic.platform_codes AS "platformCodes",
        topic.priority,
        topic.risk_level AS "riskLevel",
        topic.status,
        topic.brief_suggestion_json AS "briefSuggestion",
        topic.version,
        topic.created_at AS "createdAt",
        topic.created_at::text AS "cursorCreatedAt",
        topic.updated_at AS "updatedAt"
      FROM topic_candidates AS topic
      JOIN projects AS project
        ON project.id = topic.project_id
        AND project.tenant_id = topic.tenant_id
        AND project.workspace_id = topic.workspace_id
        AND project.deleted_at IS NULL
      JOIN workspaces AS workspace
        ON workspace.id = topic.workspace_id
        AND workspace.tenant_id = topic.tenant_id
        AND workspace.deleted_at IS NULL
      WHERE
        topic.tenant_id = ${tenantId}
        AND has_project_scope_access(
          topic.tenant_id,
          topic.workspace_id,
          topic.project_id,
          ${userId}
        )
        AND (${query.workspace_id ?? null}::uuid IS NULL OR topic.workspace_id = ${query.workspace_id ?? null})
        AND (${query.project_id ?? null}::uuid IS NULL OR topic.project_id = ${query.project_id ?? null})
        AND (${query.generation_run_id ?? null}::uuid IS NULL OR topic.generation_run_id = ${query.generation_run_id ?? null})
        AND (${query.status ?? null}::text IS NULL OR topic.status = ${query.status ?? null})
        AND (${query.risk_level ?? null}::text IS NULL OR topic.risk_level = ${query.risk_level ?? null})
        AND (${query.platform_code ?? null}::text IS NULL OR ${query.platform_code ?? null} = ANY(topic.platform_codes))
        AND (
          ${cursor?.priority ?? null}::smallint IS NULL
          OR (topic.priority, topic.created_at, topic.id) < (
            ${cursor?.priority ?? null}::smallint,
            ${cursor?.createdAt ?? null}::timestamptz,
            ${cursor?.id ?? null}::uuid
          )
        )
      ORDER BY topic.priority DESC, topic.created_at DESC, topic.id DESC
      LIMIT ${query.limit + 1}
    `;
    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(toTopicCandidateView),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              createdAt: last.cursorCreatedAt ?? toIso(last.createdAt),
              id: last.id,
              priority: last.priority,
            })
          : null,
    };
  }

  public async completeRun(
    tenantId: string,
    generationRunId: string,
    output: unknown,
  ): Promise<readonly TopicCandidateView[]> {
    const parsedOutput = TopicPlannerDataSchema.parse(output);
    return this.database.client.begin(async (transaction) => {
      const runs = await transaction<GenerationRunRow[]>`
        SELECT
          id,
          tenant_id AS "tenantId",
          workspace_id AS "workspaceId",
          project_id AS "projectId",
          package_id AS "packageId",
          variant_id AS "variantId",
          skill_name AS "skillName",
          skill_version AS "skillVersion",
          prompt_version_id AS "promptVersionId",
          model_key AS "modelKey",
          status,
          input_hash AS "inputHash",
          request_id AS "requestId",
          error_json AS error,
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          version,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM generation_runs
        WHERE
          id = ${generationRunId}
          AND tenant_id = ${tenantId}
          AND skill_name = 'topic-planner'
        FOR UPDATE
      `;
      const run = runs[0];
      if (!run?.projectId) throw new TopicNotFoundError();
      if (run.status === 'succeeded') {
        return loadRunTopics(transaction, tenantId, generationRunId);
      }
      if (!['queued', 'running'].includes(run.status)) throw new TopicStateError();
      const keywordIds = [
        ...new Set(parsedOutput.topics.flatMap((topic) => topic.brief_suggestion.keyword_ids)),
      ];
      await assertKeywords(transaction, tenantId, run.projectId, keywordIds);
      const candidates: TopicCandidateView[] = [];
      for (const topic of parsedOutput.topics) {
        const rows = await transaction<TopicCandidateRow[]>`
          INSERT INTO topic_candidates (
            tenant_id,
            workspace_id,
            project_id,
            generation_run_id,
            question,
            intent,
            entities_json,
            evidence_summary_json,
            platform_codes,
            priority,
            risk_level,
            brief_suggestion_json
          ) VALUES (
            ${tenantId},
            ${run.workspaceId},
            ${run.projectId},
            ${run.id},
            ${topic.question},
            ${topic.intent},
            ${JSON.stringify({ entities: topic.entities, schema_version: 'entity-list@1' })}::text::jsonb,
            ${JSON.stringify({ evidence_ids: topic.evidence_ids, schema_version: 'citation-set@1' })}::text::jsonb,
            ${topic.platform_codes},
            ${topic.priority},
            ${topic.risk_level},
            ${JSON.stringify(topic.brief_suggestion)}::text::jsonb
          )
          RETURNING
            id,
            tenant_id AS "tenantId",
            workspace_id AS "workspaceId",
            project_id AS "projectId",
            generation_run_id AS "generationRunId",
            question,
            intent,
            entities_json AS entities,
            evidence_summary_json AS evidence,
            platform_codes AS "platformCodes",
            priority,
            risk_level AS "riskLevel",
            status,
            brief_suggestion_json AS "briefSuggestion",
            version,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `;
        const candidate = rows[0];
        if (!candidate) throw new Error('Topic candidate insert returned no row');
        candidates.push(toTopicCandidateView(candidate));
      }
      await transaction`
        UPDATE generation_runs
        SET
          status = 'succeeded',
          started_at = COALESCE(started_at, now()),
          finished_at = now(),
          version = version + 1
        WHERE id = ${run.id} AND tenant_id = ${tenantId}
      `;
      await insertTopicAudit(transaction, {
        action: 'topic_plan.completed',
        after: candidates,
        audit: { requestId: run.requestId },
        resourceId: run.id,
        resourceType: 'generation_run',
        tenantId,
      });
      return candidates;
    });
  }

  public async adopt(
    tenantId: string,
    actorUserId: string,
    topicId: string,
    expectedVersion: number,
    input: AdoptTopicRequest,
    audit: TopicAuditContext,
  ): Promise<BriefView> {
    return this.database.client.begin(async (transaction) => {
      await assertTopicManager(transaction, tenantId, actorUserId);
      const topic = await lockTopicCandidate(transaction, tenantId, actorUserId, topicId);
      if (topic.status === 'adopted') {
        if (![topic.version, topic.version - 1].includes(expectedVersion)) {
          throw new TopicVersionConflictError();
        }
        const existing = await findBriefByTopic(transaction, tenantId, topicId);
        if (!existing) throw new TopicStateError('Adopted topic has no Brief');
        return existing;
      }
      if (topic.version !== expectedVersion) throw new TopicVersionConflictError();
      if (topic.status !== 'proposed') throw new TopicStateError();
      if (topic.evidence.evidence_ids.length === 0) {
        throw new TopicStateError('Topics without evidence cannot be adopted automatically');
      }
      if (!topic.briefSuggestion) throw new TopicStateError('Topic has no Brief suggestion');
      const briefInput = mergeBriefInput(topic.briefSuggestion, input);
      await assertKeywords(transaction, tenantId, topic.projectId, briefInput.keyword_ids);
      const rows = await transaction<BriefRow[]>`
        INSERT INTO briefs (
          tenant_id,
          workspace_id,
          project_id,
          source_topic_candidate_id,
          title,
          objective,
          audience,
          platform_codes,
          constraints_json,
          due_at,
          created_by
        ) VALUES (
          ${tenantId},
          ${topic.workspaceId},
          ${topic.projectId},
          ${topic.id},
          ${briefInput.title},
          ${briefInput.objective},
          ${briefInput.audience},
          ${topic.platformCodes},
          ${JSON.stringify(briefInput.constraints)}::text::jsonb,
          ${briefInput.due_at},
          ${actorUserId}
        )
        RETURNING
          id,
          tenant_id AS "tenantId",
          workspace_id AS "workspaceId",
          project_id AS "projectId",
          source_topic_candidate_id AS "sourceTopicCandidateId",
          title,
          objective,
          audience,
          platform_codes AS "platformCodes",
          constraints_json AS constraints,
          due_at AS "dueAt",
          created_by AS "createdBy",
          version,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `;
      const brief = rows[0];
      if (!brief) throw new Error('Topic adoption Brief insert returned no row');
      for (const keywordId of briefInput.keyword_ids) {
        await transaction`
          INSERT INTO brief_keywords (tenant_id, brief_id, keyword_id, is_primary)
          VALUES (
            ${tenantId},
            ${brief.id},
            ${keywordId},
            ${keywordId === briefInput.primary_keyword_id}
          )
        `;
      }
      for (const sourceId of topic.evidence.evidence_ids) {
        await transaction`
          INSERT INTO brief_sources (tenant_id, brief_id, source_document_id, required)
          VALUES (${tenantId}, ${brief.id}, ${sourceId}, true)
        `;
      }
      const updatedTopics = await transaction<TopicCandidateRow[]>`
        UPDATE topic_candidates
        SET status = 'adopted', version = version + 1
        WHERE
          id = ${topic.id}
          AND tenant_id = ${tenantId}
          AND status = 'proposed'
          AND version = ${expectedVersion}
        RETURNING
          id,
          tenant_id AS "tenantId",
          workspace_id AS "workspaceId",
          project_id AS "projectId",
          generation_run_id AS "generationRunId",
          question,
          intent,
          entities_json AS entities,
          evidence_summary_json AS evidence,
          platform_codes AS "platformCodes",
          priority,
          risk_level AS "riskLevel",
          status,
          brief_suggestion_json AS "briefSuggestion",
          version,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `;
      if (!updatedTopics[0]) throw new TopicVersionConflictError();
      const view = toBriefView(
        brief,
        briefInput.keyword_ids,
        briefInput.primary_keyword_id,
        topic.evidence.evidence_ids,
      );
      await insertTopicAudit(transaction, {
        action: 'topic_candidate.adopted',
        actorUserId,
        after: view,
        audit,
        before: toTopicCandidateView(topic),
        resourceId: topic.id,
        resourceType: 'topic_candidate',
        tenantId,
      });
      return view;
    });
  }
}

async function assertTopicManager(
  transaction: TransactionSql,
  tenantId: string,
  actorUserId: string,
): Promise<void> {
  const rows = await transaction<{ valid: boolean }[]>`
    SELECT true AS valid
    FROM memberships AS membership
    JOIN users AS identity_user ON identity_user.id = membership.user_id
    JOIN tenants AS tenant ON tenant.id = membership.tenant_id
    WHERE
      membership.tenant_id = ${tenantId}
      AND membership.user_id = ${actorUserId}
      AND membership.status = 'active'
      AND membership.role_code IN ('tenant_owner', 'tenant_admin', 'strategy_editor')
      AND identity_user.status = 'active'
      AND identity_user.deleted_at IS NULL
      AND tenant.status = 'active'
      AND tenant.deleted_at IS NULL
    LIMIT 1
    FOR SHARE OF membership, identity_user, tenant
  `;
  if (rows.length !== 1) throw new TopicNotFoundError();
}

async function lockTopicProject(
  transaction: TransactionSql,
  tenantId: string,
  userId: string,
  workspaceId: string,
  projectId: string,
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    SELECT project.id
    FROM projects AS project
    JOIN workspaces AS workspace
      ON workspace.id = project.workspace_id
      AND workspace.tenant_id = project.tenant_id
    WHERE
      project.id = ${projectId}
      AND project.tenant_id = ${tenantId}
      AND project.workspace_id = ${workspaceId}
      AND project.status = 'active'
      AND project.deleted_at IS NULL
      AND workspace.status = 'active'
      AND workspace.deleted_at IS NULL
      AND has_project_scope_access(
        project.tenant_id,
        project.workspace_id,
        project.id,
        ${userId}
      )
    FOR SHARE OF project, workspace
  `;
  if (rows.length !== 1) throw new TopicNotFoundError();
}

async function assertKeywordSets(
  transaction: TransactionSql,
  tenantId: string,
  projectId: string,
  keywordSetIds: readonly string[],
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    SELECT id
    FROM keyword_sets
    WHERE
      tenant_id = ${tenantId}
      AND project_id = ${projectId}
      AND id = ANY(${keywordSetIds}::uuid[])
      AND status = 'active'
      AND deleted_at IS NULL
    ORDER BY id
    FOR SHARE
  `;
  if (rows.length !== keywordSetIds.length) throw new TopicNotFoundError();
}

async function assertKeywords(
  transaction: TransactionSql,
  tenantId: string,
  projectId: string,
  keywordIds: readonly string[],
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    SELECT keyword.id
    FROM keywords AS keyword
    JOIN keyword_sets AS keyword_set
      ON keyword_set.id = keyword.keyword_set_id
      AND keyword_set.tenant_id = keyword.tenant_id
    WHERE
      keyword.tenant_id = ${tenantId}
      AND keyword.id = ANY(${keywordIds}::uuid[])
      AND keyword.status = 'active'
      AND keyword_set.project_id = ${projectId}
      AND keyword_set.status = 'active'
      AND keyword_set.deleted_at IS NULL
    ORDER BY keyword.id
    FOR SHARE OF keyword, keyword_set
  `;
  if (rows.length !== keywordIds.length) throw new TopicNotFoundError();
}

async function lockTopicCandidate(
  transaction: TransactionSql,
  tenantId: string,
  userId: string,
  topicId: string,
): Promise<TopicCandidateRow> {
  const rows = await transaction<TopicCandidateRow[]>`
    SELECT
      topic.id,
      topic.tenant_id AS "tenantId",
      topic.workspace_id AS "workspaceId",
      topic.project_id AS "projectId",
      topic.generation_run_id AS "generationRunId",
      topic.question,
      topic.intent,
      topic.entities_json AS entities,
      topic.evidence_summary_json AS evidence,
      topic.platform_codes AS "platformCodes",
      topic.priority,
      topic.risk_level AS "riskLevel",
      topic.status,
      topic.brief_suggestion_json AS "briefSuggestion",
      topic.version,
      topic.created_at AS "createdAt",
      topic.updated_at AS "updatedAt"
    FROM topic_candidates AS topic
    JOIN projects AS project
      ON project.id = topic.project_id
      AND project.tenant_id = topic.tenant_id
      AND project.workspace_id = topic.workspace_id
    JOIN workspaces AS workspace
      ON workspace.id = topic.workspace_id
      AND workspace.tenant_id = topic.tenant_id
    WHERE
      topic.id = ${topicId}
      AND topic.tenant_id = ${tenantId}
      AND project.status = 'active'
      AND project.deleted_at IS NULL
      AND workspace.status = 'active'
      AND workspace.deleted_at IS NULL
      AND has_project_scope_access(
        topic.tenant_id,
        topic.workspace_id,
        topic.project_id,
        ${userId}
      )
    FOR UPDATE OF topic, project, workspace
  `;
  const row = rows[0];
  if (!row) throw new TopicNotFoundError();
  return row;
}

async function loadRunTopics(
  transaction: TransactionSql,
  tenantId: string,
  generationRunId: string,
): Promise<readonly TopicCandidateView[]> {
  const rows = await transaction<TopicCandidateRow[]>`
    SELECT
      id,
      tenant_id AS "tenantId",
      workspace_id AS "workspaceId",
      project_id AS "projectId",
      generation_run_id AS "generationRunId",
      question,
      intent,
      entities_json AS entities,
      evidence_summary_json AS evidence,
      platform_codes AS "platformCodes",
      priority,
      risk_level AS "riskLevel",
      status,
      brief_suggestion_json AS "briefSuggestion",
      version,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM topic_candidates
    WHERE tenant_id = ${tenantId} AND generation_run_id = ${generationRunId}
    ORDER BY priority DESC, created_at, id
  `;
  return rows.map(toTopicCandidateView);
}

async function findBriefByTopic(
  transaction: TransactionSql,
  tenantId: string,
  topicId: string,
): Promise<BriefView | undefined> {
  const rows = await transaction<BriefRow[]>`
    SELECT
      id,
      tenant_id AS "tenantId",
      workspace_id AS "workspaceId",
      project_id AS "projectId",
      source_topic_candidate_id AS "sourceTopicCandidateId",
      title,
      objective,
      audience,
      platform_codes AS "platformCodes",
      constraints_json AS constraints,
      due_at AS "dueAt",
      created_by AS "createdBy",
      version,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM briefs
    WHERE tenant_id = ${tenantId} AND source_topic_candidate_id = ${topicId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return undefined;
  const keywords = await transaction<{ id: string; primary: boolean }[]>`
    SELECT keyword_id AS id, is_primary AS primary
    FROM brief_keywords
    WHERE tenant_id = ${tenantId} AND brief_id = ${row.id}
    ORDER BY is_primary DESC, keyword_id
  `;
  const sources = await transaction<{ id: string }[]>`
    SELECT source_document_id AS id
    FROM brief_sources
    WHERE tenant_id = ${tenantId} AND brief_id = ${row.id}
    ORDER BY source_document_id
  `;
  const primary = keywords.find((keyword) => keyword.primary);
  if (!primary) throw new TopicStateError('Brief has no primary keyword');
  return toBriefView(
    row,
    keywords.map((keyword) => keyword.id),
    primary.id,
    sources.map((source) => source.id),
  );
}

function mergeBriefInput(
  suggestion: TopicBriefSuggestion,
  input: AdoptTopicRequest,
): TopicBriefSuggestion {
  const merged: TopicBriefSuggestion = {
    audience: input.audience ?? suggestion.audience,
    constraints: input.constraints ?? suggestion.constraints,
    due_at: input.due_at === undefined ? suggestion.due_at : input.due_at,
    keyword_ids: input.keyword_ids ?? suggestion.keyword_ids,
    objective: input.objective ?? suggestion.objective,
    primary_keyword_id: input.primary_keyword_id ?? suggestion.primary_keyword_id,
    title: input.title ?? suggestion.title,
  };
  if (!merged.keyword_ids.includes(merged.primary_keyword_id)) {
    throw new TopicValidationError('Primary keyword must be included in keyword_ids');
  }
  return merged;
}

interface AuditInput {
  readonly action: string;
  readonly actorUserId?: string;
  readonly after: unknown;
  readonly audit: TopicAuditContext;
  readonly before?: unknown;
  readonly resourceId: string;
  readonly resourceType: 'generation_run' | 'topic_candidate';
  readonly tenantId: string;
}

async function insertTopicAudit(transaction: TransactionSql, input: AuditInput): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    INSERT INTO audit_events (
      tenant_id,
      actor_id,
      action,
      resource_type,
      resource_id,
      before_json,
      after_json,
      ip,
      request_id
    ) VALUES (
      ${input.tenantId},
      ${input.actorUserId ?? null},
      ${input.action},
      ${input.resourceType},
      ${input.resourceId},
      ${input.before === undefined ? null : JSON.stringify(input.before)}::text::jsonb,
      ${JSON.stringify(input.after)}::text::jsonb,
      ${input.audit.ip ?? null},
      ${input.audit.requestId}
    )
    RETURNING id
  `;
  if (rows.length !== 1) throw new Error('Required topic audit write failed');
}

function toGenerationRunView(row: GenerationRunRow): GenerationRunView {
  return {
    created_at: toIso(row.createdAt),
    error: row.error,
    finished_at: row.finishedAt ? toIso(row.finishedAt) : null,
    id: row.id,
    input_hash: row.inputHash,
    model_key: row.modelKey,
    package_id: row.packageId,
    project_id: row.projectId,
    prompt_version_id: row.promptVersionId,
    request_id: row.requestId,
    skill_name: row.skillName,
    skill_version: row.skillVersion,
    started_at: row.startedAt ? toIso(row.startedAt) : null,
    status: row.status,
    tenant_id: row.tenantId,
    updated_at: toIso(row.updatedAt),
    variant_id: row.variantId,
    version: row.version,
    workspace_id: row.workspaceId,
  };
}

function toTopicCandidateView(row: TopicCandidateRow): TopicCandidateView {
  return {
    brief_suggestion: row.briefSuggestion,
    created_at: toIso(row.createdAt),
    entities: row.entities.entities,
    evidence_ids: row.evidence.evidence_ids,
    generation_run_id: row.generationRunId,
    id: row.id,
    intent: row.intent,
    platform_codes: row.platformCodes,
    priority: row.priority,
    project_id: row.projectId,
    question: row.question,
    risk_level: row.riskLevel,
    status: row.status,
    tenant_id: row.tenantId,
    updated_at: toIso(row.updatedAt),
    version: row.version,
    workspace_id: row.workspaceId,
  };
}

function toBriefView(
  row: BriefRow,
  keywordIds: readonly string[],
  primaryKeywordId: string,
  sourceIds: readonly string[],
): BriefView {
  return {
    audience: row.audience,
    constraints: row.constraints,
    created_at: toIso(row.createdAt),
    created_by: row.createdBy,
    due_at: row.dueAt ? toIso(row.dueAt) : null,
    id: row.id,
    keyword_ids: keywordIds,
    objective: row.objective,
    platform_codes: row.platformCodes,
    primary_keyword_id: primaryKeywordId,
    project_id: row.projectId,
    source_ids: sourceIds,
    source_topic_candidate_id: row.sourceTopicCandidateId,
    tenant_id: row.tenantId,
    title: row.title,
    updated_at: toIso(row.updatedAt),
    version: row.version,
    workspace_id: row.workspaceId,
  };
}

function encodeCursor(cursor: TopicCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): TopicCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!isCursor(parsed)) throw new Error('Malformed topic cursor');
    return parsed;
  } catch {
    throw new TopicValidationError('Topic cursor is invalid');
  }
}

function isCursor(value: unknown): value is TopicCursor {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    typeof record['id'] === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      record['id'],
    ) &&
    typeof record['createdAt'] === 'string' &&
    Number.isFinite(new Date(record['createdAt']).getTime()) &&
    typeof record['priority'] === 'number' &&
    Number.isInteger(record['priority']) &&
    record['priority'] >= 0 &&
    record['priority'] <= 100
  );
}

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}
