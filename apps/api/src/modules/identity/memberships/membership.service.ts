import type {
  MembershipListQuery,
  MembershipView,
  TenantRoleCode,
  UpdateMembershipRequest,
  WorkspaceMembershipScope,
} from '@geo-content-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { Buffer } from 'node:buffer';
import type { TransactionSql } from 'postgres';

import { IdentityAuthDatabase } from '../auth/auth.database.js';
import {
  MembershipNotFoundError,
  MembershipPermissionError,
  MembershipStateError,
  MembershipVersionConflictError,
} from './membership.errors.js';

interface MembershipRow {
  readonly createdAt: Date | string;
  readonly cursorUpdatedAt?: string;
  readonly displayName: string;
  readonly email: string;
  readonly id: string;
  readonly roleCode: TenantRoleCode;
  readonly status: 'active' | 'disabled' | 'invited';
  readonly tenantId: string;
  readonly updatedAt: Date | string;
  readonly userId: string;
  readonly version: number;
  readonly workspaceIds: readonly string[];
}

interface MembershipActor {
  readonly roleCode: 'tenant_admin' | 'tenant_owner';
}

interface MembershipCursor {
  readonly id: string;
  readonly updatedAt: string;
}

export interface MembershipAuditContext {
  readonly ip?: string;
  readonly requestId: string;
}

export interface MembershipPageResult {
  readonly items: readonly MembershipView[];
  readonly nextCursor: string | null;
}

@Injectable()
export class MembershipService {
  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
  ) {}

  public async list(
    tenantId: string,
    actorUserId: string,
    query: MembershipListQuery,
  ): Promise<MembershipPageResult> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.database.client<MembershipRow[]>`
      SELECT
        membership.id,
        membership.tenant_id AS "tenantId",
        membership.user_id AS "userId",
        identity_user.email::text AS email,
        identity_user.display_name AS "displayName",
        membership.role_code AS "roleCode",
        membership.status,
        membership.version,
        membership.created_at AS "createdAt",
        membership.updated_at AS "updatedAt",
        membership.updated_at::text AS "cursorUpdatedAt",
        ARRAY(
          SELECT workspace_membership.workspace_id::text
          FROM workspace_memberships AS workspace_membership
          JOIN workspaces AS scoped_workspace
            ON scoped_workspace.id = workspace_membership.workspace_id
          WHERE workspace_membership.user_id = membership.user_id
            AND scoped_workspace.tenant_id = membership.tenant_id
            AND scoped_workspace.deleted_at IS NULL
          ORDER BY workspace_membership.workspace_id
        ) AS "workspaceIds"
      FROM memberships AS membership
      JOIN users AS identity_user ON identity_user.id = membership.user_id
      WHERE membership.tenant_id = ${tenantId}::uuid
        AND identity_user.deleted_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM memberships AS actor
          JOIN users AS actor_user ON actor_user.id = actor.user_id
          JOIN tenants AS tenant ON tenant.id = actor.tenant_id
          WHERE actor.tenant_id = membership.tenant_id
            AND actor.user_id = ${actorUserId}::uuid
            AND actor.status = 'active'
            AND actor.role_code IN ('tenant_owner', 'tenant_admin')
            AND actor_user.status = 'active'
            AND actor_user.deleted_at IS NULL
            AND tenant.status = 'active'
            AND tenant.deleted_at IS NULL
        )
        AND (${query.role_code ?? null}::text IS NULL OR membership.role_code = ${query.role_code ?? null})
        AND (${query.status ?? null}::text IS NULL OR membership.status = ${query.status ?? null})
        AND (
          ${query.search ?? null}::text IS NULL
          OR identity_user.email::text ILIKE ${query.search ? `%${query.search}%` : null}
          OR identity_user.display_name ILIKE ${query.search ? `%${query.search}%` : null}
        )
        AND (
          ${cursor?.updatedAt ?? null}::timestamptz IS NULL
          OR (membership.updated_at, membership.id) < (
            ${cursor?.updatedAt ?? null}::timestamptz,
            ${cursor?.id ?? null}::uuid
          )
        )
      ORDER BY membership.updated_at DESC, membership.id DESC
      LIMIT ${query.limit + 1}
    `;
    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(toMembershipView),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              id: last.id,
              updatedAt: last.cursorUpdatedAt ?? toIso(last.updatedAt),
            })
          : null,
    };
  }

  public async update(
    transaction: TransactionSql,
    tenantId: string,
    actorUserId: string,
    membershipId: string,
    expectedVersion: number,
    input: UpdateMembershipRequest,
    audit: MembershipAuditContext,
  ): Promise<MembershipView> {
    const actor = await lockActor(transaction, tenantId, actorUserId);
    const before = await lockMembership(transaction, tenantId, membershipId);
    assertCanManage(actor, before, input.role_code);
    assertVersion(before, expectedVersion);
    if (before.status === 'invited') throw new MembershipStateError();
    if (input.workspace_scope) {
      await assertWorkspaceScope(transaction, tenantId, input.workspace_scope);
    }
    await transaction`
      UPDATE memberships
      SET role_code = ${input.role_code ?? before.roleCode},
          updated_at = now(),
          version = version + 1
      WHERE id = ${membershipId}::uuid AND tenant_id = ${tenantId}::uuid
    `;
    if (input.workspace_scope) {
      await replaceWorkspaceScope(transaction, tenantId, before.userId, input.workspace_scope);
    }
    const after = await lockMembership(transaction, tenantId, membershipId);
    await insertMembershipAudit(transaction, {
      action: 'membership.updated',
      actorUserId,
      after: toMembershipView(after),
      audit,
      before: toMembershipView(before),
      membershipId,
      tenantId,
    });
    return toMembershipView(after);
  }

  public async disable(
    transaction: TransactionSql,
    tenantId: string,
    actorUserId: string,
    membershipId: string,
    expectedVersion: number,
    reason: string,
    audit: MembershipAuditContext,
  ): Promise<MembershipView> {
    const actor = await lockActor(transaction, tenantId, actorUserId);
    const before = await lockMembership(transaction, tenantId, membershipId);
    assertCanManage(actor, before);
    assertVersion(before, expectedVersion);
    if (before.status !== 'active') throw new MembershipStateError();
    await transaction`
      UPDATE memberships
      SET status = 'disabled', updated_at = now(), version = version + 1
      WHERE id = ${membershipId}::uuid AND tenant_id = ${tenantId}::uuid
    `;
    const after = await lockMembership(transaction, tenantId, membershipId);
    await insertMembershipAudit(transaction, {
      action: 'membership.disabled',
      actorUserId,
      after: { ...toMembershipView(after), reason },
      audit,
      before: toMembershipView(before),
      membershipId,
      tenantId,
    });
    return toMembershipView(after);
  }

  public async restore(
    transaction: TransactionSql,
    tenantId: string,
    actorUserId: string,
    membershipId: string,
    expectedVersion: number,
    audit: MembershipAuditContext,
  ): Promise<MembershipView> {
    const actor = await lockActor(transaction, tenantId, actorUserId);
    const before = await lockMembership(transaction, tenantId, membershipId);
    assertCanManage(actor, before);
    assertVersion(before, expectedVersion);
    if (before.status !== 'disabled') throw new MembershipStateError();
    await transaction`
      UPDATE memberships
      SET status = 'active', updated_at = now(), version = version + 1
      WHERE id = ${membershipId}::uuid AND tenant_id = ${tenantId}::uuid
    `;
    const after = await lockMembership(transaction, tenantId, membershipId);
    await insertMembershipAudit(transaction, {
      action: 'membership.restored',
      actorUserId,
      after: toMembershipView(after),
      audit,
      before: toMembershipView(before),
      membershipId,
      tenantId,
    });
    return toMembershipView(after);
  }
}

async function lockActor(
  transaction: TransactionSql,
  tenantId: string,
  actorUserId: string,
): Promise<MembershipActor> {
  const rows = await transaction<MembershipActor[]>`
    SELECT membership.role_code AS "roleCode"
    FROM memberships AS membership
    JOIN users AS identity_user ON identity_user.id = membership.user_id
    JOIN tenants AS tenant ON tenant.id = membership.tenant_id
    WHERE membership.tenant_id = ${tenantId}::uuid
      AND membership.user_id = ${actorUserId}::uuid
      AND membership.status = 'active'
      AND membership.role_code IN ('tenant_owner', 'tenant_admin')
      AND identity_user.status = 'active'
      AND identity_user.deleted_at IS NULL
      AND tenant.status = 'active'
      AND tenant.deleted_at IS NULL
    FOR UPDATE OF membership
  `;
  const actor = rows[0];
  if (!actor) throw new MembershipPermissionError();
  return actor;
}

async function lockMembership(
  transaction: TransactionSql,
  tenantId: string,
  membershipId: string,
): Promise<MembershipRow> {
  const rows = await transaction<MembershipRow[]>`
    SELECT
      membership.id,
      membership.tenant_id AS "tenantId",
      membership.user_id AS "userId",
      identity_user.email::text AS email,
      identity_user.display_name AS "displayName",
      membership.role_code AS "roleCode",
      membership.status,
      membership.version,
      membership.created_at AS "createdAt",
      membership.updated_at AS "updatedAt",
      ARRAY(
        SELECT workspace_membership.workspace_id::text
        FROM workspace_memberships AS workspace_membership
        JOIN workspaces AS scoped_workspace
          ON scoped_workspace.id = workspace_membership.workspace_id
        WHERE workspace_membership.user_id = membership.user_id
          AND scoped_workspace.tenant_id = membership.tenant_id
          AND scoped_workspace.deleted_at IS NULL
        ORDER BY workspace_membership.workspace_id
      ) AS "workspaceIds"
    FROM memberships AS membership
    JOIN users AS identity_user ON identity_user.id = membership.user_id
    WHERE membership.id = ${membershipId}::uuid
      AND membership.tenant_id = ${tenantId}::uuid
      AND identity_user.deleted_at IS NULL
    FOR UPDATE OF membership
  `;
  const row = rows[0];
  if (!row) throw new MembershipNotFoundError();
  return row;
}

function assertCanManage(
  actor: MembershipActor,
  target: MembershipRow,
  requestedRole?: TenantRoleCode,
): void {
  if (
    actor.roleCode === 'tenant_admin' &&
    (target.roleCode === 'tenant_owner' || requestedRole === 'tenant_owner')
  ) {
    throw new MembershipPermissionError();
  }
}

function assertVersion(row: MembershipRow, expectedVersion: number): void {
  if (row.version !== expectedVersion) throw new MembershipVersionConflictError();
}

async function assertWorkspaceScope(
  transaction: TransactionSql,
  tenantId: string,
  scope: WorkspaceMembershipScope,
): Promise<void> {
  const workspaceIds = scope.workspace_ids ?? [];
  if (workspaceIds.length === 0) return;
  const rows = await transaction<{ id: string }[]>`
    SELECT id
    FROM workspaces
    WHERE tenant_id = ${tenantId}::uuid
      AND id = ANY(${workspaceIds}::uuid[])
      AND status = 'active'
      AND deleted_at IS NULL
    ORDER BY id
    FOR SHARE
  `;
  if (rows.length !== workspaceIds.length) throw new MembershipNotFoundError();
}

async function replaceWorkspaceScope(
  transaction: TransactionSql,
  tenantId: string,
  userId: string,
  scope: WorkspaceMembershipScope,
): Promise<void> {
  await transaction`
    DELETE FROM workspace_memberships AS workspace_membership
    USING workspaces AS workspace
    WHERE workspace_membership.workspace_id = workspace.id
      AND workspace_membership.user_id = ${userId}::uuid
      AND workspace.tenant_id = ${tenantId}::uuid
  `;
  const workspaceIds = scope.workspace_ids ?? [];
  if (workspaceIds.length === 0) return;
  await transaction`
    INSERT INTO workspace_memberships (workspace_id, user_id, scope_json)
    SELECT workspace.id, ${userId}::uuid, ${JSON.stringify({ schema_version: 'workspace-scope@1' })}::text::jsonb
    FROM workspaces AS workspace
    WHERE workspace.tenant_id = ${tenantId}::uuid
      AND workspace.id = ANY(${workspaceIds}::uuid[])
      AND workspace.status = 'active'
      AND workspace.deleted_at IS NULL
  `;
}

interface MembershipAuditInput {
  readonly action: string;
  readonly actorUserId: string;
  readonly after: unknown;
  readonly audit: MembershipAuditContext;
  readonly before: unknown;
  readonly membershipId: string;
  readonly tenantId: string;
}

async function insertMembershipAudit(
  transaction: TransactionSql,
  input: MembershipAuditInput,
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    INSERT INTO audit_events (
      tenant_id, actor_id, action, resource_type, resource_id,
      before_json, after_json, ip, request_id
    ) VALUES (
      ${input.tenantId}::uuid,
      ${input.actorUserId}::uuid,
      ${input.action},
      'membership',
      ${input.membershipId}::uuid,
      ${JSON.stringify(input.before)}::text::jsonb,
      ${JSON.stringify(input.after)}::text::jsonb,
      ${input.audit.ip ?? null},
      ${input.audit.requestId}
    )
    RETURNING id
  `;
  if (rows.length !== 1) throw new Error('Required membership audit write failed');
}

function toMembershipView(row: MembershipRow): MembershipView {
  return {
    created_at: toIso(row.createdAt),
    display_name: row.displayName,
    email: row.email,
    id: row.id,
    role_code: row.roleCode,
    status: row.status,
    tenant_id: row.tenantId,
    updated_at: toIso(row.updatedAt),
    user_id: row.userId,
    version: row.version,
    workspace_scope: row.workspaceIds.length > 0 ? { workspace_ids: [...row.workspaceIds] } : {},
  };
}

function encodeCursor(cursor: MembershipCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): MembershipCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error();
    const id = Reflect.get(parsed, 'id');
    const updatedAt = Reflect.get(parsed, 'updatedAt');
    if (
      typeof id !== 'string' ||
      typeof updatedAt !== 'string' ||
      !/^[0-9a-f-]{36}$/iu.test(id) ||
      Number.isNaN(Date.parse(updatedAt))
    ) {
      throw new Error();
    }
    return { id, updatedAt };
  } catch {
    throw new MembershipNotFoundError();
  }
}

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}
