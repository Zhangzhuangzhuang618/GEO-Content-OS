import type {
  CreateProjectRequest,
  ProjectListQuery,
  ProjectView,
  UpdateProjectRequest,
} from '@geo-content-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { Buffer } from 'node:buffer';
import type { TransactionSql } from 'postgres';

import { IdentityAuthDatabase } from '../../identity/auth/auth.database.js';
import {
  ProjectNotFoundError,
  ProjectStateError,
  ProjectValidationError,
  ProjectVersionConflictError,
} from './project.errors.js';

interface ProjectRow {
  readonly createdAt: Date | string;
  readonly cursorUpdatedAt?: string;
  readonly endDate: Date | string | null;
  readonly id: string;
  readonly name: string;
  readonly objective: string | null;
  readonly ownerId: string;
  readonly startDate: Date | string | null;
  readonly status: 'active' | 'archived';
  readonly tenantId: string;
  readonly updatedAt: Date | string;
  readonly version: number;
  readonly workspaceId: string;
  readonly workspaceStatus?: 'active' | 'archived';
}

interface ProjectCursor {
  readonly id: string;
  readonly updatedAt: string;
}

export interface ProjectAuditContext {
  readonly ip?: string;
  readonly requestId: string;
}

export interface ProjectPageResult {
  readonly items: readonly ProjectView[];
  readonly nextCursor: string | null;
}

@Injectable()
export class ProjectService {
  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
  ) {}

  public async create(
    transaction: TransactionSql,
    tenantId: string,
    actorUserId: string,
    input: CreateProjectRequest,
    audit: ProjectAuditContext,
  ): Promise<ProjectView> {
    assertDateRange(input.start_date ?? null, input.end_date ?? null);
    const rows = await transaction<ProjectRow[]>`
      INSERT INTO projects (
        tenant_id,
        workspace_id,
        name,
        owner_id,
        objective,
        start_date,
        end_date
      )
      SELECT
        workspace.tenant_id,
        workspace.id,
        ${input.name},
        owner_membership.user_id,
        ${input.objective ?? null},
        ${input.start_date ?? null}::date,
        ${input.end_date ?? null}::date
      FROM workspaces AS workspace
      JOIN memberships AS actor_membership
        ON actor_membership.tenant_id = workspace.tenant_id
        AND actor_membership.user_id = ${actorUserId}
        AND actor_membership.status = 'active'
        AND actor_membership.role_code IN ('tenant_owner', 'tenant_admin', 'strategy_editor')
      JOIN users AS actor_user
        ON actor_user.id = actor_membership.user_id
        AND actor_user.status = 'active'
        AND actor_user.deleted_at IS NULL
      JOIN memberships AS owner_membership
        ON owner_membership.tenant_id = workspace.tenant_id
        AND owner_membership.user_id = ${input.owner_id}
        AND owner_membership.status = 'active'
      JOIN users AS owner_user
        ON owner_user.id = owner_membership.user_id
        AND owner_user.status = 'active'
        AND owner_user.deleted_at IS NULL
      WHERE
        workspace.id = ${input.workspace_id}
        AND workspace.tenant_id = ${tenantId}
        AND workspace.status = 'active'
        AND workspace.deleted_at IS NULL
        AND has_project_scope_access(
          workspace.tenant_id,
          workspace.id,
          NULL,
          ${actorUserId}
        )
        AND has_project_scope_access(
          workspace.tenant_id,
          workspace.id,
          NULL,
          ${input.owner_id}
        )
      FOR SHARE OF workspace, actor_membership, actor_user, owner_membership, owner_user
      RETURNING
        id,
        tenant_id AS "tenantId",
        workspace_id AS "workspaceId",
        name,
        owner_id AS "ownerId",
        objective,
        status,
        start_date AS "startDate",
        end_date AS "endDate",
        version,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;
    const row = rows[0];
    if (!row) throw new ProjectNotFoundError();
    const view = toProjectView(row);
    await insertProjectAudit(transaction, {
      action: 'project.created',
      actorUserId,
      after: view,
      audit,
      resourceId: row.id,
      tenantId,
    });
    return view;
  }

  public async list(
    tenantId: string,
    userId: string,
    query: ProjectListQuery,
  ): Promise<ProjectPageResult> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.database.client<ProjectRow[]>`
      SELECT
        project.id,
        project.tenant_id AS "tenantId",
        project.workspace_id AS "workspaceId",
        project.name,
        project.owner_id AS "ownerId",
        project.objective,
        project.status,
        project.start_date AS "startDate",
        project.end_date AS "endDate",
        project.version,
        project.created_at AS "createdAt",
        project.updated_at AS "updatedAt",
        project.updated_at::text AS "cursorUpdatedAt"
      FROM projects AS project
      JOIN workspaces AS workspace
        ON workspace.id = project.workspace_id
        AND workspace.tenant_id = project.tenant_id
        AND workspace.deleted_at IS NULL
      WHERE
        project.tenant_id = ${tenantId}
        AND project.deleted_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM memberships AS active_membership
          JOIN users AS active_user ON active_user.id = active_membership.user_id
          JOIN tenants AS active_tenant ON active_tenant.id = active_membership.tenant_id
          WHERE
            active_membership.tenant_id = project.tenant_id
            AND active_membership.user_id = ${userId}
            AND active_membership.status = 'active'
            AND active_user.status = 'active'
            AND active_user.deleted_at IS NULL
            AND active_tenant.status = 'active'
            AND active_tenant.deleted_at IS NULL
        )
        AND has_project_scope_access(
          project.tenant_id,
          project.workspace_id,
          project.id,
          ${userId}
        )
        AND (${query.workspace_id ?? null}::uuid IS NULL OR project.workspace_id = ${query.workspace_id ?? null})
        AND (${query.owner_id ?? null}::uuid IS NULL OR project.owner_id = ${query.owner_id ?? null})
        AND (${query.status ?? null}::text IS NULL OR project.status = ${query.status ?? null})
        AND (
          ${query.search ?? null}::text IS NULL
          OR project.name ILIKE ${query.search ? `%${query.search}%` : null}
          OR project.objective ILIKE ${query.search ? `%${query.search}%` : null}
        )
        AND (
          ${cursor?.updatedAt ?? null}::timestamptz IS NULL
          OR (project.updated_at, project.id) < (
            ${cursor?.updatedAt ?? null}::timestamptz,
            ${cursor?.id ?? null}::uuid
          )
        )
      ORDER BY project.updated_at DESC, project.id DESC
      LIMIT ${query.limit + 1}
    `;
    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(toProjectView),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              id: last.id,
              updatedAt: last.cursorUpdatedAt ?? toIso(last.updatedAt),
            })
          : null,
    };
  }

  public async find(tenantId: string, userId: string, projectId: string): Promise<ProjectView> {
    const rows = await this.database.client<ProjectRow[]>`
      SELECT
        project.id,
        project.tenant_id AS "tenantId",
        project.workspace_id AS "workspaceId",
        project.name,
        project.owner_id AS "ownerId",
        project.objective,
        project.status,
        project.start_date AS "startDate",
        project.end_date AS "endDate",
        project.version,
        project.created_at AS "createdAt",
        project.updated_at AS "updatedAt"
      FROM projects AS project
      JOIN workspaces AS workspace
        ON workspace.id = project.workspace_id
        AND workspace.tenant_id = project.tenant_id
        AND workspace.deleted_at IS NULL
      WHERE
        project.id = ${projectId}
        AND project.tenant_id = ${tenantId}
        AND project.deleted_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM memberships AS active_membership
          JOIN users AS active_user ON active_user.id = active_membership.user_id
          JOIN tenants AS active_tenant ON active_tenant.id = active_membership.tenant_id
          WHERE
            active_membership.tenant_id = project.tenant_id
            AND active_membership.user_id = ${userId}
            AND active_membership.status = 'active'
            AND active_user.status = 'active'
            AND active_user.deleted_at IS NULL
            AND active_tenant.status = 'active'
            AND active_tenant.deleted_at IS NULL
        )
        AND has_project_scope_access(
          project.tenant_id,
          project.workspace_id,
          project.id,
          ${userId}
        )
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw new ProjectNotFoundError();
    return toProjectView(row);
  }

  public async update(
    transaction: TransactionSql,
    tenantId: string,
    actorUserId: string,
    projectId: string,
    expectedVersion: number,
    input: UpdateProjectRequest,
    audit: ProjectAuditContext,
  ): Promise<ProjectView> {
    await assertProjectManager(transaction, tenantId, actorUserId);
    const before = await lockProject(transaction, tenantId, projectId);
    if (!before) throw new ProjectNotFoundError();
    await assertProjectAccess(transaction, tenantId, actorUserId, before.workspaceId, projectId);
    if (before.version !== expectedVersion) throw new ProjectVersionConflictError();
    if (before.status !== 'active' || before.workspaceStatus !== 'active') {
      throw new ProjectStateError();
    }
    if (input.status === 'active') {
      throw new ProjectStateError('An active project cannot be restored or reactivated');
    }
    const startDate = input.start_date === undefined ? toDate(before.startDate) : input.start_date;
    const endDate = input.end_date === undefined ? toDate(before.endDate) : input.end_date;
    assertDateRange(startDate, endDate);

    const ownerId = input.owner_id ?? before.ownerId;
    await assertProjectOwner(transaction, tenantId, ownerId, before.workspaceId, projectId);
    if (input.status === 'archived') {
      const activeRuns = await transaction<{ id: string }[]>`
        SELECT id
        FROM generation_runs
        WHERE
          tenant_id = ${tenantId}
          AND project_id = ${projectId}
          AND status IN ('queued', 'running')
        LIMIT 1
        FOR UPDATE
      `;
      if (activeRuns.length > 0) {
        throw new ProjectStateError('A project with an active generation run cannot be archived');
      }
    }

    const rows = await transaction<ProjectRow[]>`
      UPDATE projects
      SET
        name = COALESCE(${input.name ?? null}, name),
        owner_id = ${ownerId},
        objective = CASE
          WHEN ${input.objective !== undefined}::boolean THEN ${input.objective ?? null}
          ELSE objective
        END,
        start_date = ${startDate}::date,
        end_date = ${endDate}::date,
        status = COALESCE(${input.status ?? null}, status),
        version = version + 1
      WHERE
        id = ${projectId}
        AND tenant_id = ${tenantId}
        AND version = ${expectedVersion}
        AND status = 'active'
        AND deleted_at IS NULL
      RETURNING
        id,
        tenant_id AS "tenantId",
        workspace_id AS "workspaceId",
        name,
        owner_id AS "ownerId",
        objective,
        status,
        start_date AS "startDate",
        end_date AS "endDate",
        version,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;
    const row = rows[0];
    if (!row) throw new ProjectVersionConflictError();
    const view = toProjectView(row);
    await insertProjectAudit(transaction, {
      action: input.status === 'archived' ? 'project.archived' : 'project.updated',
      actorUserId,
      after: view,
      audit,
      before: toProjectView(before),
      resourceId: projectId,
      tenantId,
    });
    return view;
  }
}

async function assertProjectManager(
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
  if (rows.length !== 1) throw new ProjectNotFoundError();
}

async function assertProjectAccess(
  transaction: TransactionSql,
  tenantId: string,
  userId: string,
  workspaceId: string,
  projectId: string,
): Promise<void> {
  const rows = await transaction<{ valid: boolean }[]>`
    SELECT true AS valid
    FROM projects AS project
    WHERE
      project.id = ${projectId}
      AND project.tenant_id = ${tenantId}
      AND project.workspace_id = ${workspaceId}
      AND has_project_scope_access(
        project.tenant_id,
        project.workspace_id,
        project.id,
        ${userId}
      )
    LIMIT 1
  `;
  if (rows.length !== 1) throw new ProjectNotFoundError();
}

async function assertProjectOwner(
  transaction: TransactionSql,
  tenantId: string,
  ownerId: string,
  workspaceId: string,
  projectId: string,
): Promise<void> {
  const rows = await transaction<{ valid: boolean }[]>`
    SELECT true AS valid
    FROM memberships AS owner_membership
    JOIN users AS owner_user
      ON owner_user.id = owner_membership.user_id
      AND owner_user.status = 'active'
      AND owner_user.deleted_at IS NULL
    JOIN projects AS project
      ON project.id = ${projectId}
      AND project.tenant_id = owner_membership.tenant_id
      AND project.workspace_id = ${workspaceId}
    WHERE
      owner_membership.tenant_id = ${tenantId}
      AND owner_membership.user_id = ${ownerId}
      AND owner_membership.status = 'active'
      AND (
        owner_membership.role_code IN ('tenant_owner', 'tenant_admin')
        OR has_project_scope_access(
          project.tenant_id,
          project.workspace_id,
          project.id,
          ${ownerId}
        )
      )
    LIMIT 1
    FOR SHARE OF owner_membership, owner_user
  `;
  if (rows.length !== 1) throw new ProjectNotFoundError();
}

async function lockProject(
  transaction: TransactionSql,
  tenantId: string,
  projectId: string,
): Promise<ProjectRow | undefined> {
  const rows = await transaction<ProjectRow[]>`
    SELECT
      project.id,
      project.tenant_id AS "tenantId",
      project.workspace_id AS "workspaceId",
      project.name,
      project.owner_id AS "ownerId",
      project.objective,
      project.status,
      project.start_date AS "startDate",
      project.end_date AS "endDate",
      project.version,
      project.created_at AS "createdAt",
      project.updated_at AS "updatedAt",
      workspace.status AS "workspaceStatus"
    FROM projects AS project
    JOIN workspaces AS workspace
      ON workspace.id = project.workspace_id
      AND workspace.tenant_id = project.tenant_id
      AND workspace.deleted_at IS NULL
    WHERE
      project.id = ${projectId}
      AND project.tenant_id = ${tenantId}
      AND project.deleted_at IS NULL
    FOR UPDATE OF project, workspace
  `;
  return rows[0];
}

interface AuditInput {
  readonly action: string;
  readonly actorUserId: string;
  readonly after: unknown;
  readonly audit: ProjectAuditContext;
  readonly before?: unknown;
  readonly resourceId: string;
  readonly tenantId: string;
}

async function insertProjectAudit(transaction: TransactionSql, input: AuditInput): Promise<void> {
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
      'project',
      ${input.resourceId},
      ${input.before === undefined ? null : JSON.stringify(input.before)}::text::jsonb,
      ${JSON.stringify(input.after)}::text::jsonb,
      ${input.audit.ip ?? null},
      ${input.audit.requestId}
    )
    RETURNING id
  `;
  if (rows.length !== 1) throw new Error('Required project audit write failed');
}

function toProjectView(row: ProjectRow): ProjectView {
  return {
    created_at: toIso(row.createdAt),
    end_date: toDate(row.endDate),
    id: row.id,
    name: row.name,
    objective: row.objective,
    owner_id: row.ownerId,
    start_date: toDate(row.startDate),
    status: row.status,
    tenant_id: row.tenantId,
    updated_at: toIso(row.updatedAt),
    version: row.version,
    workspace_id: row.workspaceId,
  };
}

function assertDateRange(startDate: string | null, endDate: string | null): void {
  if (startDate && endDate && endDate < startDate) {
    throw new ProjectValidationError('Project end date must be on or after its start date');
  }
}

function toDate(value: Date | string | null): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function encodeCursor(cursor: ProjectCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): ProjectCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!isCursor(decoded)) throw new Error('Malformed project cursor');
    return decoded;
  } catch {
    throw new ProjectValidationError('Project cursor is invalid');
  }
}

function isCursor(value: unknown): value is ProjectCursor {
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
  return new Date(value).toISOString();
}
