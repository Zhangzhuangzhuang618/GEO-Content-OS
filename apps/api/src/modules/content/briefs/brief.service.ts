import type {
  BriefConstraints,
  BriefListQuery,
  BriefView,
  CreateBriefRequest,
  PlatformCode,
  UpdateBriefRequest,
} from '@geo-content-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { TransactionSql } from 'postgres';

import { IdentityAuthDatabase } from '../../identity/auth/auth.database.js';
import { BriefCostEstimator, type BriefCostEstimateInput } from './brief-cost-estimator.js';
import {
  BriefNotFoundError,
  BriefStateError,
  BriefValidationError,
  BriefVersionConflictError,
} from './brief.errors.js';

interface BriefRow {
  readonly audience: string;
  readonly constraints: BriefConstraints;
  readonly createdAt: Date | string;
  readonly createdBy: string;
  readonly dueAt: Date | string | null;
  readonly id: string;
  readonly keywordIds: readonly string[];
  readonly objective: BriefView['objective'];
  readonly platformCodes: readonly PlatformCode[];
  readonly primaryKeywordId: string | null;
  readonly projectId: string;
  readonly sourceIds: readonly string[];
  readonly sourceTopicCandidateId: string | null;
  readonly tenantId: string;
  readonly title: string;
  readonly updatedAt: Date | string;
  readonly version: number;
  readonly workspaceId: string;
}

interface BriefCursor {
  readonly id: string;
  readonly updatedAt: string;
}

export interface BriefPageResult {
  readonly items: readonly BriefView[];
  readonly nextCursor: string | null;
}

export interface BriefAuditContext {
  readonly ip?: string;
  readonly requestId: string;
}

@Injectable()
export class BriefService {
  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
    @Inject(BriefCostEstimator) private readonly costEstimator: BriefCostEstimator,
  ) {}

  public async create(
    transaction: TransactionSql,
    tenantId: string,
    actorUserId: string,
    input: CreateBriefRequest,
    audit: BriefAuditContext,
  ): Promise<BriefView> {
    await assertBriefManager(transaction, tenantId, actorUserId);
    await lockActiveProject(
      transaction,
      tenantId,
      actorUserId,
      input.workspace_id,
      input.project_id,
    );
    validateBriefRules(
      input.objective,
      input.keyword_ids,
      input.primary_keyword_id,
      input.source_ids,
    );
    await assertKeywords(
      transaction,
      tenantId,
      input.project_id,
      input.keyword_ids,
      input.platform_codes,
    );
    await assertSources(
      transaction,
      tenantId,
      input.workspace_id,
      input.project_id,
      input.source_ids,
    );

    const rows = await transaction<BriefRow[]>`
      INSERT INTO briefs (
        tenant_id,
        workspace_id,
        project_id,
        title,
        objective,
        audience,
        platform_codes,
        constraints_json,
        due_at,
        created_by
      ) VALUES (
        ${tenantId}::uuid,
        ${input.workspace_id}::uuid,
        ${input.project_id}::uuid,
        ${input.title},
        ${input.objective},
        ${input.audience},
        ${input.platform_codes},
        ${JSON.stringify(input.constraints)}::text::jsonb,
        ${input.due_at},
        ${actorUserId}::uuid
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
    const inserted = rows[0];
    if (!inserted) throw new Error('Brief insert returned no row');
    await replaceKeywords(
      transaction,
      tenantId,
      inserted.id,
      input.keyword_ids,
      input.primary_keyword_id,
    );
    await replaceSources(transaction, tenantId, inserted.id, input.source_ids);
    const view = toBriefView({
      ...inserted,
      keywordIds: input.keyword_ids,
      primaryKeywordId: input.primary_keyword_id,
      sourceIds: input.source_ids,
    });
    await insertBriefAudit(transaction, {
      action: 'brief.created',
      actorUserId,
      after: view,
      audit,
      resourceId: view.id,
      tenantId,
    });
    return view;
  }

  public async list(
    tenantId: string,
    userId: string,
    query: BriefListQuery,
  ): Promise<BriefPageResult> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await selectBriefs(this.database.client, {
      ...(cursor ? { cursor } : {}),
      limit: query.limit + 1,
      query,
      tenantId,
      userId,
    });
    const hasNext = rows.length > query.limit;
    const pageRows = hasNext ? rows.slice(0, query.limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(toBriefView),
      nextCursor:
        hasNext && last ? encodeCursor({ id: last.id, updatedAt: toIso(last.updatedAt) }) : null,
    };
  }

  public async find(tenantId: string, userId: string, briefId: string): Promise<BriefView> {
    const rows = await selectBriefs(this.database.client, {
      briefId,
      limit: 1,
      query: { limit: 1 },
      tenantId,
      userId,
    });
    const row = rows[0];
    if (!row) throw new BriefNotFoundError();
    return toBriefView(row);
  }

  public async estimateCost(
    tenantId: string,
    userId: string,
    briefId: string,
  ): Promise<BriefCostEstimateInput> {
    return this.costEstimator.estimate(await this.find(tenantId, userId, briefId));
  }

  public async update(
    transaction: TransactionSql,
    tenantId: string,
    actorUserId: string,
    briefId: string,
    expectedVersion: number,
    input: UpdateBriefRequest,
    audit: BriefAuditContext,
  ): Promise<BriefView> {
    await assertBriefManager(transaction, tenantId, actorUserId);
    const before = await lockBrief(transaction, tenantId, actorUserId, briefId);
    if (!before) throw new BriefNotFoundError();
    if (before.version !== expectedVersion) throw new BriefVersionConflictError();

    const keywordIds = input.keyword_ids ?? before.keywordIds;
    const primaryKeywordId = input.primary_keyword_id ?? before.primaryKeywordId;
    if (!primaryKeywordId) throw new BriefStateError('Brief has no primary keyword');
    const sourceIds = input.source_ids ?? before.sourceIds;
    const objective = input.objective ?? before.objective;
    const platformCodes = input.platform_codes ?? before.platformCodes;
    validateBriefRules(objective, keywordIds, primaryKeywordId, sourceIds);
    await assertKeywords(transaction, tenantId, before.projectId, keywordIds, platformCodes);
    await assertSources(transaction, tenantId, before.workspaceId, before.projectId, sourceIds);

    const rows = await transaction<BriefRow[]>`
      UPDATE briefs
      SET
        title = COALESCE(${input.title ?? null}, title),
        objective = COALESCE(${input.objective ?? null}, objective),
        audience = COALESCE(${input.audience ?? null}, audience),
        platform_codes = COALESCE(${input.platform_codes ?? null}, platform_codes),
        constraints_json = CASE
          WHEN ${input.constraints !== undefined}::boolean
          THEN ${input.constraints === undefined ? null : JSON.stringify(input.constraints)}::text::jsonb
          ELSE constraints_json
        END,
        due_at = CASE
          WHEN ${input.due_at !== undefined}::boolean THEN ${input.due_at ?? null}::timestamptz
          ELSE due_at
        END,
        version = version + 1
      WHERE id = ${briefId}::uuid
        AND tenant_id = ${tenantId}::uuid
        AND version = ${expectedVersion}
        AND deleted_at IS NULL
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
    const updated = rows[0];
    if (!updated) throw new BriefVersionConflictError();
    if (input.keyword_ids !== undefined || input.primary_keyword_id !== undefined) {
      await replaceKeywords(transaction, tenantId, briefId, keywordIds, primaryKeywordId);
    }
    if (input.source_ids !== undefined) {
      await replaceSources(transaction, tenantId, briefId, sourceIds);
    }
    const after = toBriefView({
      ...updated,
      keywordIds,
      primaryKeywordId,
      sourceIds,
    });
    await insertBriefAudit(transaction, {
      action: 'brief.updated',
      actorUserId,
      after,
      audit,
      before: toBriefView(before),
      resourceId: briefId,
      tenantId,
    });
    return after;
  }
}

type SqlClient = IdentityAuthDatabase['client'] | TransactionSql;

interface SelectBriefInput {
  readonly briefId?: string;
  readonly cursor?: BriefCursor;
  readonly limit: number;
  readonly query: Partial<BriefListQuery>;
  readonly tenantId: string;
  readonly userId: string;
}

async function selectBriefs(client: SqlClient, input: SelectBriefInput): Promise<BriefRow[]> {
  return client<BriefRow[]>`
    SELECT
      brief.id,
      brief.tenant_id AS "tenantId",
      brief.workspace_id AS "workspaceId",
      brief.project_id AS "projectId",
      brief.source_topic_candidate_id AS "sourceTopicCandidateId",
      brief.title,
      brief.objective,
      brief.audience,
      brief.platform_codes AS "platformCodes",
      brief.constraints_json AS constraints,
      brief.due_at AS "dueAt",
      brief.created_by AS "createdBy",
      brief.version,
      brief.created_at AS "createdAt",
      brief.updated_at AS "updatedAt",
      keyword_links."keywordIds",
      keyword_links."primaryKeywordId",
      source_links."sourceIds"
    FROM briefs AS brief
    JOIN projects AS project
      ON project.id = brief.project_id
      AND project.tenant_id = brief.tenant_id
      AND project.workspace_id = brief.workspace_id
      AND project.status = 'active'
      AND project.deleted_at IS NULL
    JOIN workspaces AS workspace
      ON workspace.id = brief.workspace_id
      AND workspace.tenant_id = brief.tenant_id
      AND workspace.status = 'active'
      AND workspace.deleted_at IS NULL
    JOIN LATERAL (
      SELECT
        array_agg(link.keyword_id ORDER BY link.is_primary DESC, link.keyword_id) AS "keywordIds",
        (max(link.keyword_id::text) FILTER (WHERE link.is_primary))::uuid AS "primaryKeywordId"
      FROM brief_keywords AS link
      WHERE link.tenant_id = brief.tenant_id AND link.brief_id = brief.id
    ) AS keyword_links ON keyword_links."primaryKeywordId" IS NOT NULL
    CROSS JOIN LATERAL (
      SELECT COALESCE(
        array_agg(link.source_document_id ORDER BY link.source_document_id),
        ARRAY[]::uuid[]
      ) AS "sourceIds"
      FROM brief_sources AS link
      WHERE link.tenant_id = brief.tenant_id AND link.brief_id = brief.id
    ) AS source_links
    WHERE brief.tenant_id = ${input.tenantId}::uuid
      AND brief.deleted_at IS NULL
      AND has_project_scope_access(
        brief.tenant_id,
        brief.workspace_id,
        brief.project_id,
        ${input.userId}::uuid
      )
      AND (${input.briefId ?? null}::uuid IS NULL OR brief.id = ${input.briefId ?? null}::uuid)
      AND (${input.query.workspace_id ?? null}::uuid IS NULL OR brief.workspace_id = ${input.query.workspace_id ?? null}::uuid)
      AND (${input.query.project_id ?? null}::uuid IS NULL OR brief.project_id = ${input.query.project_id ?? null}::uuid)
      AND (${input.query.created_by ?? null}::uuid IS NULL OR brief.created_by = ${input.query.created_by ?? null}::uuid)
      AND (${input.query.objective ?? null}::text IS NULL OR brief.objective = ${input.query.objective ?? null})
      AND (${input.query.platform_code ?? null}::text IS NULL OR ${input.query.platform_code ?? null} = ANY(brief.platform_codes))
      AND (${input.query.search ?? null}::text IS NULL OR position(lower(${input.query.search ?? null}) in lower(brief.title)) > 0)
      AND (
        ${input.cursor?.updatedAt ?? null}::timestamptz IS NULL
        OR (brief.updated_at, brief.id) < (
          ${input.cursor?.updatedAt ?? null}::timestamptz,
          ${input.cursor?.id ?? null}::uuid
        )
      )
    ORDER BY brief.updated_at DESC, brief.id DESC
    LIMIT ${input.limit}
  `;
}

async function lockBrief(
  transaction: TransactionSql,
  tenantId: string,
  userId: string,
  briefId: string,
): Promise<BriefRow | undefined> {
  const rows = await transaction<BriefRow[]>`
    SELECT
      brief.id,
      brief.tenant_id AS "tenantId",
      brief.workspace_id AS "workspaceId",
      brief.project_id AS "projectId",
      brief.source_topic_candidate_id AS "sourceTopicCandidateId",
      brief.title,
      brief.objective,
      brief.audience,
      brief.platform_codes AS "platformCodes",
      brief.constraints_json AS constraints,
      brief.due_at AS "dueAt",
      brief.created_by AS "createdBy",
      brief.version,
      brief.created_at AS "createdAt",
      brief.updated_at AS "updatedAt",
      keyword_links."keywordIds",
      keyword_links."primaryKeywordId",
      source_links."sourceIds"
    FROM briefs AS brief
    JOIN projects AS project
      ON project.id = brief.project_id
      AND project.tenant_id = brief.tenant_id
      AND project.workspace_id = brief.workspace_id
      AND project.status = 'active'
      AND project.deleted_at IS NULL
    JOIN workspaces AS workspace
      ON workspace.id = brief.workspace_id
      AND workspace.tenant_id = brief.tenant_id
      AND workspace.status = 'active'
      AND workspace.deleted_at IS NULL
    JOIN LATERAL (
      SELECT
        array_agg(link.keyword_id ORDER BY link.is_primary DESC, link.keyword_id) AS "keywordIds",
        (max(link.keyword_id::text) FILTER (WHERE link.is_primary))::uuid AS "primaryKeywordId"
      FROM brief_keywords AS link
      WHERE link.tenant_id = brief.tenant_id AND link.brief_id = brief.id
    ) AS keyword_links ON keyword_links."primaryKeywordId" IS NOT NULL
    CROSS JOIN LATERAL (
      SELECT COALESCE(
        array_agg(link.source_document_id ORDER BY link.source_document_id),
        ARRAY[]::uuid[]
      ) AS "sourceIds"
      FROM brief_sources AS link
      WHERE link.tenant_id = brief.tenant_id AND link.brief_id = brief.id
    ) AS source_links
    WHERE brief.id = ${briefId}::uuid
      AND brief.tenant_id = ${tenantId}::uuid
      AND brief.deleted_at IS NULL
      AND has_project_scope_access(
        brief.tenant_id,
        brief.workspace_id,
        brief.project_id,
        ${userId}::uuid
      )
    FOR UPDATE OF brief
  `;
  return rows[0];
}

async function assertBriefManager(
  transaction: TransactionSql,
  tenantId: string,
  actorUserId: string,
): Promise<void> {
  const rows = await transaction<{ valid: boolean }[]>`
    SELECT true AS valid
    FROM memberships AS membership
    JOIN users AS identity_user ON identity_user.id = membership.user_id
    JOIN tenants AS tenant ON tenant.id = membership.tenant_id
    WHERE membership.tenant_id = ${tenantId}::uuid
      AND membership.user_id = ${actorUserId}::uuid
      AND membership.status = 'active'
      AND membership.role_code IN (
        'tenant_owner', 'tenant_admin', 'strategy_editor', 'content_editor'
      )
      AND identity_user.status = 'active'
      AND identity_user.deleted_at IS NULL
      AND tenant.status = 'active'
      AND tenant.deleted_at IS NULL
    LIMIT 1
    FOR SHARE OF membership, identity_user, tenant
  `;
  if (rows.length !== 1) throw new BriefNotFoundError();
}

async function lockActiveProject(
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
    WHERE project.id = ${projectId}::uuid
      AND project.tenant_id = ${tenantId}::uuid
      AND project.workspace_id = ${workspaceId}::uuid
      AND project.status = 'active'
      AND project.deleted_at IS NULL
      AND workspace.status = 'active'
      AND workspace.deleted_at IS NULL
      AND has_project_scope_access(
        project.tenant_id,
        project.workspace_id,
        project.id,
        ${userId}::uuid
      )
    FOR SHARE OF project, workspace
  `;
  if (rows.length !== 1) throw new BriefNotFoundError();
}

async function assertKeywords(
  transaction: TransactionSql,
  tenantId: string,
  projectId: string,
  keywordIds: readonly string[],
  platformCodes: readonly PlatformCode[],
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    SELECT keyword.id
    FROM keywords AS keyword
    JOIN keyword_sets AS keyword_set
      ON keyword_set.id = keyword.keyword_set_id
      AND keyword_set.tenant_id = keyword.tenant_id
    WHERE keyword.tenant_id = ${tenantId}::uuid
      AND keyword.id = ANY(${keywordIds}::uuid[])
      AND keyword.status = 'active'
      AND keyword_set.status = 'active'
      AND keyword_set.project_id = ${projectId}::uuid
      AND (
        cardinality(keyword.platform_scope) = 0
        OR keyword.platform_scope && ${platformCodes}::varchar[]
      )
    FOR SHARE OF keyword, keyword_set
  `;
  if (rows.length !== keywordIds.length) {
    throw new BriefStateError(
      'Every Brief keyword must be active and valid for its project/platform',
    );
  }
}

async function assertSources(
  transaction: TransactionSql,
  tenantId: string,
  workspaceId: string,
  projectId: string,
  sourceIds: readonly string[],
): Promise<void> {
  if (sourceIds.length === 0) return;
  const rows = await transaction<{ id: string }[]>`
    SELECT source.id
    FROM source_documents AS source
    WHERE source.tenant_id = ${tenantId}::uuid
      AND source.workspace_id = ${workspaceId}::uuid
      AND source.id = ANY(${sourceIds}::uuid[])
      AND (source.project_id IS NULL OR source.project_id = ${projectId}::uuid)
      AND source.status = 'active'
      AND source.trust_level <> 'untrusted'
      AND source.deleted_at IS NULL
      AND (source.effective_from IS NULL OR source.effective_from <= current_date)
      AND (source.effective_to IS NULL OR source.effective_to >= current_date)
    FOR SHARE OF source
  `;
  if (rows.length !== sourceIds.length) {
    throw new BriefStateError(
      'Every Brief source must be active, trusted, effective, and in scope',
    );
  }
}

async function replaceKeywords(
  transaction: TransactionSql,
  tenantId: string,
  briefId: string,
  keywordIds: readonly string[],
  primaryKeywordId: string,
): Promise<void> {
  await transaction`
    DELETE FROM brief_keywords
    WHERE tenant_id = ${tenantId}::uuid AND brief_id = ${briefId}::uuid
  `;
  await transaction`
    INSERT INTO brief_keywords (tenant_id, brief_id, keyword_id, is_primary)
    SELECT
      ${tenantId}::uuid,
      ${briefId}::uuid,
      input.keyword_id,
      input.keyword_id = ${primaryKeywordId}::uuid
    FROM unnest(${keywordIds}::uuid[]) WITH ORDINALITY AS input(keyword_id, ordinal)
    ORDER BY input.ordinal
  `;
}

async function replaceSources(
  transaction: TransactionSql,
  tenantId: string,
  briefId: string,
  sourceIds: readonly string[],
): Promise<void> {
  await transaction`
    DELETE FROM brief_sources
    WHERE tenant_id = ${tenantId}::uuid AND brief_id = ${briefId}::uuid
  `;
  if (sourceIds.length === 0) return;
  await transaction`
    INSERT INTO brief_sources (tenant_id, brief_id, source_document_id, required)
    SELECT ${tenantId}::uuid, ${briefId}::uuid, input.source_id, true
    FROM unnest(${sourceIds}::uuid[]) WITH ORDINALITY AS input(source_id, ordinal)
    ORDER BY input.ordinal
  `;
}

function validateBriefRules(
  objective: BriefView['objective'],
  keywordIds: readonly string[],
  primaryKeywordId: string,
  sourceIds: readonly string[],
): void {
  if (keywordIds.length === 0 || !keywordIds.includes(primaryKeywordId)) {
    throw new BriefValidationError('A Brief requires one included primary keyword');
  }
  if (['trust', 'education'].includes(objective) && sourceIds.length === 0) {
    throw new BriefValidationError('Trust and education Briefs require an evidence source');
  }
}

interface AuditInput {
  readonly action: 'brief.created' | 'brief.updated';
  readonly actorUserId: string;
  readonly after: BriefView;
  readonly audit: BriefAuditContext;
  readonly before?: BriefView;
  readonly resourceId: string;
  readonly tenantId: string;
}

async function insertBriefAudit(transaction: TransactionSql, input: AuditInput): Promise<void> {
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
      ${input.tenantId}::uuid,
      ${input.actorUserId}::uuid,
      ${input.action},
      'brief',
      ${input.resourceId}::uuid,
      ${input.before === undefined ? null : JSON.stringify(input.before)}::text::jsonb,
      ${JSON.stringify(input.after)}::text::jsonb,
      ${input.audit.ip ?? null},
      ${input.audit.requestId}
    )
    RETURNING id
  `;
  if (rows.length !== 1) throw new Error('Required Brief audit write failed');
}

function toBriefView(row: BriefRow): BriefView {
  if (!row.primaryKeywordId) throw new BriefStateError('Brief has no primary keyword');
  return {
    audience: row.audience,
    constraints: row.constraints,
    created_at: toIso(row.createdAt),
    created_by: row.createdBy,
    due_at: row.dueAt ? toIso(row.dueAt) : null,
    id: row.id,
    keyword_ids: [...row.keywordIds],
    objective: row.objective,
    platform_codes: [...row.platformCodes],
    primary_keyword_id: row.primaryKeywordId,
    project_id: row.projectId,
    source_ids: [...row.sourceIds],
    source_topic_candidate_id: row.sourceTopicCandidateId,
    tenant_id: row.tenantId,
    title: row.title,
    updated_at: toIso(row.updatedAt),
    version: row.version,
    workspace_id: row.workspaceId,
  };
}

function encodeCursor(cursor: BriefCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): BriefCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!isCursor(parsed)) throw new Error('Malformed Brief cursor');
    return parsed;
  } catch {
    throw new BriefValidationError('Brief cursor is invalid');
  }
}

function isCursor(value: unknown): value is BriefCursor {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    typeof record['id'] === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      record['id'],
    ) &&
    typeof record['updatedAt'] === 'string' &&
    Number.isFinite(new Date(record['updatedAt']).getTime())
  );
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
