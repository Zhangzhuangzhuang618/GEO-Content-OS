import type {
  CreateKeywordSetRequest,
  Keyword,
  KeywordInput,
  KeywordListQuery,
  KeywordSetDetail,
  KeywordSetQuery,
  KeywordSetView,
} from '@geo-content-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { TransactionSql } from 'postgres';

import { IdentityAuthDatabase } from '../../identity/auth/auth.database.js';
import {
  KeywordNotFoundError,
  KeywordStateError,
  KeywordValidationError,
} from './keyword.errors.js';

export interface KeywordSetRow {
  readonly createdAt: Date | string;
  readonly cursorUpdatedAt?: string;
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly projectStatus?: 'active' | 'archived';
  readonly status: 'active' | 'archived';
  readonly tenantId: string;
  readonly updatedAt: Date | string;
  readonly workspaceStatus?: 'active' | 'archived';
}

interface KeywordSetCursor {
  readonly id: string;
  readonly updatedAt: string;
}

export interface KeywordSetPageResult {
  readonly items: readonly KeywordSetView[];
  readonly nextCursor: string | null;
}

export interface KeywordPageResult {
  readonly items: readonly Keyword[];
  readonly nextCursor: string | null;
}

interface KeywordCursor {
  readonly id: string;
  readonly priority: number;
}

interface KeywordRow {
  readonly createdAt: Date | string;
  readonly id: string;
  readonly intents: Keyword['intents'];
  readonly keywordSetId: string;
  readonly platformScope: Keyword['platform_scope'];
  readonly priority: number;
  readonly status: Keyword['status'];
  readonly synonyms: readonly string[];
  readonly tenantId: string;
  readonly term: string;
  readonly updatedAt: Date | string;
}

export interface KeywordAuditContext {
  readonly ip?: string;
  readonly requestId: string;
}

@Injectable()
export class KeywordService {
  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
  ) {}

  public async list(
    tenantId: string,
    userId: string,
    query: KeywordSetQuery,
  ): Promise<KeywordSetPageResult> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.database.client<KeywordSetRow[]>`
      SELECT
        keyword_set.id,
        keyword_set.tenant_id AS "tenantId",
        keyword_set.project_id AS "projectId",
        keyword_set.name,
        keyword_set.status,
        keyword_set.created_at AS "createdAt",
        keyword_set.updated_at AS "updatedAt",
        keyword_set.updated_at::text AS "cursorUpdatedAt"
      FROM keyword_sets AS keyword_set
      JOIN projects AS project
        ON project.id = keyword_set.project_id
        AND project.tenant_id = keyword_set.tenant_id
        AND project.deleted_at IS NULL
      JOIN workspaces AS workspace
        ON workspace.id = project.workspace_id
        AND workspace.tenant_id = project.tenant_id
        AND workspace.deleted_at IS NULL
      WHERE
        keyword_set.tenant_id = ${tenantId}
        AND keyword_set.deleted_at IS NULL
        AND has_project_scope_access(
          project.tenant_id,
          project.workspace_id,
          project.id,
          ${userId}
        )
        AND (${query.project_id ?? null}::uuid IS NULL OR keyword_set.project_id = ${query.project_id ?? null})
        AND (${query.status ?? null}::text IS NULL OR keyword_set.status = ${query.status ?? null})
        AND (
          ${cursor?.updatedAt ?? null}::timestamptz IS NULL
          OR (keyword_set.updated_at, keyword_set.id) < (
            ${cursor?.updatedAt ?? null}::timestamptz,
            ${cursor?.id ?? null}::uuid
          )
        )
      ORDER BY keyword_set.updated_at DESC, keyword_set.id DESC
      LIMIT ${query.limit + 1}
    `;
    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(toKeywordSetView),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              id: last.id,
              updatedAt: last.cursorUpdatedAt ?? toIso(last.updatedAt),
            })
          : null,
    };
  }

  public async find(
    tenantId: string,
    userId: string,
    keywordSetId: string,
  ): Promise<KeywordSetDetail> {
    return this.database.client.begin(async (transaction) => {
      const keywordSet = await findKeywordSet(transaction, tenantId, userId, keywordSetId);
      const keywords = await transaction<KeywordRow[]>`
        SELECT
          keyword.id,
          keyword.tenant_id AS "tenantId",
          keyword.keyword_set_id AS "keywordSetId",
          keyword.term::text AS term,
          keyword.intents,
          keyword.priority,
          keyword.synonyms,
          keyword.platform_scope AS "platformScope",
          keyword.status,
          keyword.created_at AS "createdAt",
          keyword.updated_at AS "updatedAt"
        FROM keywords AS keyword
        WHERE
          keyword.tenant_id = ${tenantId}
          AND keyword.keyword_set_id = ${keywordSetId}
        ORDER BY keyword.priority DESC, keyword.term, keyword.id
      `;
      return { ...toKeywordSetView(keywordSet), keywords: keywords.map(toKeywordView) };
    });
  }

  public async listKeywords(
    tenantId: string,
    userId: string,
    keywordSetId: string,
    query: KeywordListQuery,
  ): Promise<KeywordPageResult> {
    const cursor = query.cursor ? decodeKeywordCursor(query.cursor) : undefined;
    return this.database.client.begin(async (transaction) => {
      await findKeywordSet(transaction, tenantId, userId, keywordSetId);
      const rows = await transaction<KeywordRow[]>`
        SELECT
          keyword.id,
          keyword.tenant_id AS "tenantId",
          keyword.keyword_set_id AS "keywordSetId",
          keyword.term::text AS term,
          keyword.intents,
          keyword.priority,
          keyword.synonyms,
          keyword.platform_scope AS "platformScope",
          keyword.status,
          keyword.created_at AS "createdAt",
          keyword.updated_at AS "updatedAt"
        FROM keywords AS keyword
        WHERE
          keyword.tenant_id = ${tenantId}
          AND keyword.keyword_set_id = ${keywordSetId}
          AND (${query.status ?? null}::text IS NULL OR keyword.status = ${query.status ?? null})
          AND (
            ${query.search ?? null}::text IS NULL
            OR position(lower(${query.search ?? null}) in lower(keyword.term::text)) > 0
          )
          AND (
            ${cursor?.priority ?? null}::smallint IS NULL
            OR (keyword.priority, keyword.id) < (
              ${cursor?.priority ?? null}::smallint,
              ${cursor?.id ?? null}::uuid
            )
          )
        ORDER BY keyword.priority DESC, keyword.id DESC
        LIMIT ${query.limit + 1}
      `;
      const hasMore = rows.length > query.limit;
      const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
      const last = pageRows.at(-1);
      return {
        items: pageRows.map(toKeywordView),
        nextCursor:
          hasMore && last
            ? Buffer.from(
                JSON.stringify({ id: last.id, priority: last.priority }),
                'utf8',
              ).toString('base64url')
            : null,
      };
    });
  }

  public async createSet(
    transaction: TransactionSql,
    tenantId: string,
    actorUserId: string,
    input: CreateKeywordSetRequest,
    audit: KeywordAuditContext,
  ): Promise<KeywordSetView> {
    await assertKeywordManager(transaction, tenantId, actorUserId);
    await lockActiveProject(transaction, tenantId, actorUserId, input.project_id);
    const rows = await transaction<KeywordSetRow[]>`
      INSERT INTO keyword_sets (tenant_id, project_id, name)
      VALUES (${tenantId}, ${input.project_id}, ${input.name})
      RETURNING
        id,
        tenant_id AS "tenantId",
        project_id AS "projectId",
        name,
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;
    const row = rows[0];
    if (!row) throw new Error('Keyword set insert returned no row');
    const view = toKeywordSetView(row);
    await insertKeywordAudit(transaction, {
      action: 'keyword_set.created',
      actorUserId,
      after: view,
      audit,
      resourceId: row.id,
      resourceType: 'keyword_set',
      tenantId,
    });
    return view;
  }

  public async upsert(
    transaction: TransactionSql,
    tenantId: string,
    actorUserId: string,
    keywordSetId: string,
    input: readonly KeywordInput[],
    audit: KeywordAuditContext,
  ): Promise<readonly Keyword[]> {
    await assertKeywordManager(transaction, tenantId, actorUserId);
    const keywordSet = await lockKeywordSet(transaction, tenantId, actorUserId, keywordSetId);
    if (
      keywordSet.status !== 'active' ||
      keywordSet.projectStatus !== 'active' ||
      keywordSet.workspaceStatus !== 'active'
    ) {
      throw new KeywordStateError();
    }

    const inputRows = input.map((keyword, ordinal) => ({ ...keyword, ordinal }));
    const serializedInput = JSON.stringify(inputRows);
    const beforeRows = await transaction<KeywordRow[]>`
      WITH input_keyword AS (
        SELECT term, ordinal
        FROM jsonb_to_recordset(${serializedInput}::text::jsonb)
          AS item(term text, ordinal integer)
      )
      SELECT
        keyword.id,
        keyword.tenant_id AS "tenantId",
        keyword.keyword_set_id AS "keywordSetId",
        keyword.term::text AS term,
        keyword.intents,
        keyword.priority,
        keyword.synonyms,
        keyword.platform_scope AS "platformScope",
        keyword.status,
        keyword.created_at AS "createdAt",
        keyword.updated_at AS "updatedAt"
      FROM keywords AS keyword
      JOIN input_keyword ON input_keyword.term::citext = keyword.term
      WHERE
        keyword.tenant_id = ${tenantId}
        AND keyword.keyword_set_id = ${keywordSetId}
      ORDER BY input_keyword.ordinal
    `;

    const rows = await transaction<KeywordRow[]>`
      WITH input_keyword AS (
        SELECT term, intents, priority, synonyms, platform_scope, status, ordinal
        FROM jsonb_to_recordset(${serializedInput}::text::jsonb) AS item(
          term text,
          intents varchar(32)[],
          priority smallint,
          synonyms text[],
          platform_scope varchar(24)[],
          status varchar(16),
          ordinal integer
        )
      ), upserted AS (
        INSERT INTO keywords (
          tenant_id,
          keyword_set_id,
          term,
          intent,
          intents,
          priority,
          synonyms,
          platform_scope,
          status
        )
        SELECT
          ${tenantId},
          ${keywordSetId},
          btrim(input_keyword.term),
          input_keyword.intents[1],
          input_keyword.intents,
          input_keyword.priority,
          input_keyword.synonyms,
          input_keyword.platform_scope,
          input_keyword.status
        FROM input_keyword
        ORDER BY input_keyword.ordinal
        ON CONFLICT (tenant_id, keyword_set_id, term) DO UPDATE SET
          term = EXCLUDED.term,
          intent = EXCLUDED.intent,
          intents = EXCLUDED.intents,
          priority = EXCLUDED.priority,
          synonyms = EXCLUDED.synonyms,
          platform_scope = EXCLUDED.platform_scope,
          status = EXCLUDED.status
        RETURNING
          id,
          tenant_id AS "tenantId",
          keyword_set_id AS "keywordSetId",
          term::text AS term,
          intents,
          priority,
          synonyms,
          platform_scope AS "platformScope",
          status,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      )
      SELECT upserted.*
      FROM upserted
      JOIN input_keyword ON input_keyword.term::citext = upserted.term::citext
      ORDER BY input_keyword.ordinal
    `;
    if (rows.length !== input.length)
      throw new Error('Keyword upsert returned an incomplete batch');
    const before = beforeRows.map(toKeywordView);
    const after = rows.map(toKeywordView);
    await insertKeywordAudit(transaction, {
      action: 'keywords.upserted',
      actorUserId,
      after,
      audit,
      before,
      resourceId: keywordSetId,
      resourceType: 'keyword_set',
      tenantId,
    });
    return after;
  }
}

export async function assertKeywordManager(
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
  if (rows.length !== 1) throw new KeywordNotFoundError();
}

async function lockActiveProject(
  transaction: TransactionSql,
  tenantId: string,
  userId: string,
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
  if (rows.length !== 1) throw new KeywordNotFoundError();
}

export async function lockKeywordSet(
  transaction: TransactionSql,
  tenantId: string,
  userId: string,
  keywordSetId: string,
): Promise<KeywordSetRow> {
  const rows = await transaction<KeywordSetRow[]>`
    SELECT
      keyword_set.id,
      keyword_set.tenant_id AS "tenantId",
      keyword_set.project_id AS "projectId",
      keyword_set.name,
      keyword_set.status,
      keyword_set.created_at AS "createdAt",
      keyword_set.updated_at AS "updatedAt",
      project.status AS "projectStatus",
      workspace.status AS "workspaceStatus"
    FROM keyword_sets AS keyword_set
    JOIN projects AS project
      ON project.id = keyword_set.project_id
      AND project.tenant_id = keyword_set.tenant_id
    JOIN workspaces AS workspace
      ON workspace.id = project.workspace_id
      AND workspace.tenant_id = project.tenant_id
    WHERE
      keyword_set.id = ${keywordSetId}
      AND keyword_set.tenant_id = ${tenantId}
      AND keyword_set.deleted_at IS NULL
      AND project.deleted_at IS NULL
      AND workspace.deleted_at IS NULL
      AND has_project_scope_access(
        project.tenant_id,
        project.workspace_id,
        project.id,
        ${userId}
      )
    FOR UPDATE OF keyword_set, project, workspace
  `;
  const row = rows[0];
  if (!row) throw new KeywordNotFoundError();
  return row;
}

export async function findKeywordSet(
  transaction: TransactionSql,
  tenantId: string,
  userId: string,
  keywordSetId: string,
): Promise<KeywordSetRow> {
  const rows = await transaction<KeywordSetRow[]>`
    SELECT
      keyword_set.id,
      keyword_set.tenant_id AS "tenantId",
      keyword_set.project_id AS "projectId",
      keyword_set.name,
      keyword_set.status,
      keyword_set.created_at AS "createdAt",
      keyword_set.updated_at AS "updatedAt"
    FROM keyword_sets AS keyword_set
    JOIN projects AS project
      ON project.id = keyword_set.project_id
      AND project.tenant_id = keyword_set.tenant_id
      AND project.deleted_at IS NULL
    JOIN workspaces AS workspace
      ON workspace.id = project.workspace_id
      AND workspace.tenant_id = project.tenant_id
      AND workspace.deleted_at IS NULL
    WHERE
      keyword_set.id = ${keywordSetId}
      AND keyword_set.tenant_id = ${tenantId}
      AND keyword_set.deleted_at IS NULL
      AND has_project_scope_access(
        project.tenant_id,
        project.workspace_id,
        project.id,
        ${userId}
      )
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new KeywordNotFoundError();
  return row;
}

interface AuditInput {
  readonly action: string;
  readonly actorUserId: string;
  readonly after: unknown;
  readonly audit: KeywordAuditContext;
  readonly before?: unknown;
  readonly resourceId: string;
  readonly resourceType: 'keyword_set';
  readonly tenantId: string;
}

async function insertKeywordAudit(transaction: TransactionSql, input: AuditInput): Promise<void> {
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
      ${input.actorUserId},
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
  if (rows.length !== 1) throw new Error('Required keyword audit write failed');
}

function toKeywordSetView(row: KeywordSetRow): KeywordSetView {
  return {
    created_at: toIso(row.createdAt),
    id: row.id,
    name: row.name,
    project_id: row.projectId,
    status: row.status,
    tenant_id: row.tenantId,
    updated_at: toIso(row.updatedAt),
  };
}

function toKeywordView(row: KeywordRow): Keyword {
  return {
    created_at: toIso(row.createdAt),
    id: row.id,
    intents: row.intents,
    keyword_set_id: row.keywordSetId,
    platform_scope: row.platformScope,
    priority: row.priority,
    status: row.status,
    synonyms: row.synonyms,
    tenant_id: row.tenantId,
    term: row.term,
    updated_at: toIso(row.updatedAt),
  };
}

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function encodeCursor(cursor: KeywordSetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): KeywordSetCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!isCursor(decoded)) throw new Error('Malformed keyword set cursor');
    return decoded;
  } catch {
    throw new KeywordValidationError();
  }
}

function isCursor(value: unknown): value is KeywordSetCursor {
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

function decodeKeywordCursor(value: string): KeywordCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!decoded || typeof decoded !== 'object') throw new Error('Malformed keyword cursor');
    const record = decoded as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      typeof record['id'] !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        record['id'],
      ) ||
      typeof record['priority'] !== 'number' ||
      !Number.isInteger(record['priority']) ||
      record['priority'] < 0 ||
      record['priority'] > 100
    ) {
      throw new Error('Malformed keyword cursor');
    }
    return { id: record['id'], priority: record['priority'] };
  } catch {
    throw new KeywordValidationError();
  }
}
