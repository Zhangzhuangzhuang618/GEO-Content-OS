import type {
  CreateWorkspaceRequest,
  UpdateWorkspaceRequest,
  WorkspaceListQuery,
  WorkspaceSettings,
  WorkspaceView,
} from '@geo-content-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { Buffer } from 'node:buffer';
import type { TransactionSql } from 'postgres';

import { IdentityAuthDatabase } from '../../identity/auth/auth.database.js';
import {
  WorkspaceNotFoundError,
  WorkspaceStateError,
  WorkspaceValidationError,
  WorkspaceVersionConflictError,
} from './workspace.errors.js';

interface WorkspaceRow {
  readonly createdAt: Date | string;
  readonly cursorUpdatedAt?: string;
  readonly id: string;
  readonly name: string;
  readonly settings: WorkspaceSettings | Record<string, never>;
  readonly slug: string;
  readonly status: 'active' | 'archived';
  readonly tenantId: string;
  readonly timezone: string;
  readonly updatedAt: Date | string;
  readonly version: number;
}

interface WorkspaceCursor {
  readonly id: string;
  readonly updatedAt: string;
}

export interface WorkspaceAuditContext {
  readonly ip?: string;
  readonly requestId: string;
}

export interface WorkspacePageResult {
  readonly items: readonly WorkspaceView[];
  readonly nextCursor: string | null;
}

@Injectable()
export class WorkspaceService {
  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
  ) {}

  public async create(
    transaction: TransactionSql,
    tenantId: string,
    actorUserId: string,
    input: CreateWorkspaceRequest,
    audit: WorkspaceAuditContext,
  ): Promise<WorkspaceView> {
    assertTimeZone(input.timezone);
    const rows = await transaction<WorkspaceRow[]>`
      INSERT INTO workspaces (
        tenant_id,
        name,
        slug,
        timezone,
        settings_json
      )
      SELECT
        tenant.id,
        ${input.name},
        ${input.slug},
        ${input.timezone},
        ${JSON.stringify(input.settings)}::text::jsonb
      FROM tenants AS tenant
      WHERE
        tenant.id = ${tenantId}
        AND tenant.status = 'active'
        AND tenant.deleted_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM memberships AS membership
          JOIN users AS identity_user ON identity_user.id = membership.user_id
          WHERE
            membership.tenant_id = tenant.id
            AND membership.user_id = ${actorUserId}
            AND membership.status = 'active'
            AND membership.role_code IN ('tenant_owner', 'tenant_admin')
            AND identity_user.status = 'active'
            AND identity_user.deleted_at IS NULL
        )
      RETURNING
        id,
        tenant_id AS "tenantId",
        name,
        slug::text AS slug,
        timezone,
        settings_json AS settings,
        status,
        version,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;
    const row = rows[0];
    if (!row) throw new WorkspaceNotFoundError();
    const view = toWorkspaceView(row);
    await insertWorkspaceAudit(transaction, {
      action: 'workspace.created',
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
    hasTenantWideAccess: boolean,
    query: WorkspaceListQuery,
  ): Promise<WorkspacePageResult> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.database.client<WorkspaceRow[]>`
      SELECT
        workspace.id,
        workspace.tenant_id AS "tenantId",
        workspace.name,
        workspace.slug::text AS slug,
        workspace.timezone,
        workspace.settings_json AS settings,
        workspace.status,
        workspace.version,
        workspace.created_at AS "createdAt",
        workspace.updated_at AS "updatedAt",
        workspace.updated_at::text AS "cursorUpdatedAt"
      FROM workspaces AS workspace
      WHERE
        workspace.tenant_id = ${tenantId}
        AND workspace.deleted_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM memberships AS current_membership
          JOIN users AS active_user ON active_user.id = current_membership.user_id
          JOIN tenants AS current_tenant ON current_tenant.id = current_membership.tenant_id
          WHERE
            current_membership.tenant_id = workspace.tenant_id
            AND current_membership.user_id = ${userId}
            AND current_membership.status = 'active'
            AND active_user.status = 'active'
            AND active_user.deleted_at IS NULL
            AND current_tenant.status = 'active'
            AND current_tenant.deleted_at IS NULL
        )
        AND (${query.status ?? null}::text IS NULL OR workspace.status = ${query.status ?? null})
        AND (
          ${query.search ?? null}::text IS NULL
          OR workspace.name ILIKE ${query.search ? `%${query.search}%` : null}
          OR workspace.slug::text ILIKE ${query.search ? `%${query.search}%` : null}
        )
        AND (
          ${hasTenantWideAccess}::boolean
          OR NOT EXISTS (
            SELECT 1
            FROM workspace_memberships AS any_scope
            JOIN workspaces AS scoped_workspace ON scoped_workspace.id = any_scope.workspace_id
            WHERE
              any_scope.user_id = ${userId}
              AND scoped_workspace.tenant_id = ${tenantId}
              AND scoped_workspace.deleted_at IS NULL
          )
          OR EXISTS (
            SELECT 1
            FROM workspace_memberships AS member_scope
            WHERE
              member_scope.user_id = ${userId}
              AND member_scope.workspace_id = workspace.id
          )
        )
        AND (
          ${cursor?.updatedAt ?? null}::timestamptz IS NULL
          OR (workspace.updated_at, workspace.id) < (
            ${cursor?.updatedAt ?? null}::timestamptz,
            ${cursor?.id ?? null}::uuid
          )
        )
      ORDER BY workspace.updated_at DESC, workspace.id DESC
      LIMIT ${query.limit + 1}
    `;
    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(toWorkspaceView),
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
    hasTenantWideAccess: boolean,
    workspaceId: string,
  ): Promise<WorkspaceView> {
    const rows = await this.database.client<WorkspaceRow[]>`
      SELECT
        workspace.id,
        workspace.tenant_id AS "tenantId",
        workspace.name,
        workspace.slug::text AS slug,
        workspace.timezone,
        workspace.settings_json AS settings,
        workspace.status,
        workspace.version,
        workspace.created_at AS "createdAt",
        workspace.updated_at AS "updatedAt"
      FROM workspaces AS workspace
      WHERE
        workspace.id = ${workspaceId}
        AND workspace.tenant_id = ${tenantId}
        AND workspace.deleted_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM memberships AS current_membership
          JOIN users AS active_user ON active_user.id = current_membership.user_id
          JOIN tenants AS current_tenant ON current_tenant.id = current_membership.tenant_id
          WHERE
            current_membership.tenant_id = workspace.tenant_id
            AND current_membership.user_id = ${userId}
            AND current_membership.status = 'active'
            AND active_user.status = 'active'
            AND active_user.deleted_at IS NULL
            AND current_tenant.status = 'active'
            AND current_tenant.deleted_at IS NULL
        )
        AND (
          ${hasTenantWideAccess}::boolean
          OR NOT EXISTS (
            SELECT 1
            FROM workspace_memberships AS any_scope
            JOIN workspaces AS scoped_workspace ON scoped_workspace.id = any_scope.workspace_id
            WHERE
              any_scope.user_id = ${userId}
              AND scoped_workspace.tenant_id = ${tenantId}
              AND scoped_workspace.deleted_at IS NULL
          )
          OR EXISTS (
            SELECT 1
            FROM workspace_memberships AS member_scope
            WHERE
              member_scope.user_id = ${userId}
              AND member_scope.workspace_id = workspace.id
          )
        )
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw new WorkspaceNotFoundError();
    return toWorkspaceView(row);
  }

  public async update(
    transaction: TransactionSql,
    tenantId: string,
    actorUserId: string,
    workspaceId: string,
    expectedVersion: number,
    input: UpdateWorkspaceRequest,
    audit: WorkspaceAuditContext,
  ): Promise<WorkspaceView> {
    if (input.timezone) assertTimeZone(input.timezone);
    await assertWorkspaceManager(transaction, tenantId, actorUserId);
    const before = await lockWorkspace(transaction, tenantId, workspaceId);
    if (!before) throw new WorkspaceNotFoundError();
    if (before.version !== expectedVersion) throw new WorkspaceVersionConflictError();
    if (before.status !== 'active') throw new WorkspaceStateError();

    const rows = await transaction<WorkspaceRow[]>`
      UPDATE workspaces
      SET
        name = COALESCE(${input.name ?? null}, name),
        slug = COALESCE(${input.slug ?? null}, slug),
        timezone = COALESCE(${input.timezone ?? null}, timezone),
        settings_json = COALESCE(
          ${input.settings ? JSON.stringify(input.settings) : null}::text::jsonb,
          settings_json
        ),
        version = version + 1
      WHERE
        id = ${workspaceId}
        AND tenant_id = ${tenantId}
        AND version = ${expectedVersion}
        AND status = 'active'
        AND deleted_at IS NULL
      RETURNING
        id,
        tenant_id AS "tenantId",
        name,
        slug::text AS slug,
        timezone,
        settings_json AS settings,
        status,
        version,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;
    const row = rows[0];
    if (!row) throw new WorkspaceVersionConflictError();
    const view = toWorkspaceView(row);
    await insertWorkspaceAudit(transaction, {
      action: 'workspace.updated',
      actorUserId,
      after: view,
      audit,
      before: toWorkspaceView(before),
      resourceId: workspaceId,
      tenantId,
    });
    return view;
  }

  public async archive(
    tenantId: string,
    actorUserId: string,
    workspaceId: string,
    expectedVersion: number,
    reason: string,
    audit: WorkspaceAuditContext,
  ): Promise<WorkspaceView> {
    return this.database.client.begin(async (transaction) => {
      await assertWorkspaceManager(transaction, tenantId, actorUserId);
      await transaction`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`workspace-archive:${tenantId}`}, 0)
        )
      `;
      const before = await lockWorkspace(transaction, tenantId, workspaceId);
      if (!before) throw new WorkspaceNotFoundError();
      if (before.status === 'archived' && before.version === expectedVersion + 1) {
        return toWorkspaceView(before);
      }
      if (before.version !== expectedVersion) throw new WorkspaceVersionConflictError();
      if (before.status !== 'active') throw new WorkspaceStateError();

      const active = await transaction<{ id: string }[]>`
        SELECT id
        FROM workspaces
        WHERE tenant_id = ${tenantId} AND status = 'active' AND deleted_at IS NULL
        ORDER BY id
        FOR UPDATE
      `;
      if (active.length <= 1) {
        throw new WorkspaceStateError('A tenant must retain at least one active workspace');
      }
      const rows = await transaction<WorkspaceRow[]>`
        UPDATE workspaces
        SET status = 'archived', version = version + 1
        WHERE
          id = ${workspaceId}
          AND tenant_id = ${tenantId}
          AND version = ${expectedVersion}
          AND status = 'active'
          AND deleted_at IS NULL
        RETURNING
          id,
          tenant_id AS "tenantId",
          name,
          slug::text AS slug,
          timezone,
          settings_json AS settings,
          status,
          version,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `;
      const row = rows[0];
      if (!row) throw new WorkspaceVersionConflictError();
      const view = toWorkspaceView(row);
      await insertWorkspaceAudit(transaction, {
        action: 'workspace.archived',
        actorUserId,
        after: { ...view, reason },
        audit,
        before: toWorkspaceView(before),
        resourceId: workspaceId,
        tenantId,
      });
      return view;
    });
  }
}

async function assertWorkspaceManager(
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
      AND membership.role_code IN ('tenant_owner', 'tenant_admin')
      AND identity_user.status = 'active'
      AND identity_user.deleted_at IS NULL
      AND tenant.status = 'active'
      AND tenant.deleted_at IS NULL
    LIMIT 1
  `;
  if (rows.length !== 1) throw new WorkspaceNotFoundError();
}

async function lockWorkspace(
  transaction: TransactionSql,
  tenantId: string,
  workspaceId: string,
): Promise<WorkspaceRow | undefined> {
  const rows = await transaction<WorkspaceRow[]>`
    SELECT
      workspace.id,
      workspace.tenant_id AS "tenantId",
      workspace.name,
      workspace.slug::text AS slug,
      workspace.timezone,
      workspace.settings_json AS settings,
      workspace.status,
      workspace.version,
      workspace.created_at AS "createdAt",
      workspace.updated_at AS "updatedAt"
    FROM workspaces AS workspace
    WHERE
      workspace.id = ${workspaceId}
      AND workspace.tenant_id = ${tenantId}
      AND workspace.deleted_at IS NULL
    FOR UPDATE
  `;
  return rows[0];
}

interface AuditInput {
  readonly action: string;
  readonly actorUserId: string;
  readonly after: unknown;
  readonly audit: WorkspaceAuditContext;
  readonly before?: unknown;
  readonly resourceId: string;
  readonly tenantId: string;
}

async function insertWorkspaceAudit(transaction: TransactionSql, input: AuditInput): Promise<void> {
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
      'workspace',
      ${input.resourceId},
      ${input.before === undefined ? null : JSON.stringify(input.before)}::text::jsonb,
      ${JSON.stringify(input.after)}::text::jsonb,
      ${input.audit.ip ?? null},
      ${input.audit.requestId}
    )
    RETURNING id
  `;
  if (rows.length !== 1) throw new Error('Required workspace audit write failed');
}

function toWorkspaceView(row: WorkspaceRow): WorkspaceView {
  return {
    created_at: toIso(row.createdAt),
    id: row.id,
    name: row.name,
    settings:
      Object.keys(row.settings).length === 0
        ? { schema_version: 'workspace-settings@1' }
        : (row.settings as WorkspaceSettings),
    slug: row.slug,
    status: row.status,
    tenant_id: row.tenantId,
    timezone: row.timezone,
    updated_at: toIso(row.updatedAt),
    version: row.version,
  };
}

function assertTimeZone(value: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
  } catch {
    throw new WorkspaceValidationError('Workspace timezone must be a valid IANA timezone');
  }
}

function encodeCursor(cursor: WorkspaceCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): WorkspaceCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!isCursor(decoded)) throw new Error('Malformed workspace cursor');
    return decoded;
  } catch {
    throw new WorkspaceValidationError('Workspace cursor is invalid');
  }
}

function isCursor(value: unknown): value is WorkspaceCursor {
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
