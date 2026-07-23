import { isTenantPermission, type PermissionCode } from '@geo-content-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { TransactionSql } from 'postgres';

import { IdentityAuthDatabase } from '../identity/auth/auth.database.js';
import type { SupportGrantRequest, SupportGrantView } from './support-access.dto.js';
import {
  SupportAccessNotFoundError,
  SupportAccessValidationError,
} from './support-access.errors.js';

interface SupportGrantRow {
  readonly createdAt: Date | string;
  readonly expiresAt: Date | string;
  readonly grantedBy: string;
  readonly id: string;
  readonly platformUserId: string;
  readonly reason: string;
  readonly revokedAt: Date | string | null;
  readonly scope: SupportGrantView['scope'];
  readonly tenantId: string;
}

export interface SupportAccessAuditContext {
  readonly ip?: string;
  readonly requestId: string;
}

export interface SupportAccessOperationInput extends SupportAccessAuditContext {
  readonly action: string;
  readonly actorUserId: string;
  readonly grantId: string;
  readonly permission: PermissionCode;
  readonly resourceId?: string;
  readonly resourceType: string;
  readonly tenantId: string;
}

export interface AuthorizedSupportAccess {
  readonly actorUserId: string;
  readonly grantId: string;
  readonly permission: PermissionCode;
  readonly tenantId: string;
}

@Injectable()
export class SupportAccessService {
  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
  ) {}

  public async createGrant(
    grantedBy: string,
    request: SupportGrantRequest,
    audit: SupportAccessAuditContext,
  ): Promise<SupportGrantView> {
    const expiresAt = new Date(request.expires_at);
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= Date.now() ||
      expiresAt.getTime() > Date.now() + 8 * 60 * 60 * 1_000
    ) {
      throw new SupportAccessValidationError();
    }
    const scope: SupportGrantView['scope'] = {
      permissions: request.scope.permissions,
      resource_types: request.scope.resource_types,
      schema_version: 'support-access@1',
    };
    return this.database.client.begin(async (transaction) => {
      await assertGrantTargetInTransaction(
        transaction,
        grantedBy,
        request.platform_user_id,
        request.tenant_id,
      );
      const rows = await transaction<SupportGrantRow[]>`
        WITH access_clock AS (SELECT clock_timestamp() AS created_at)
        INSERT INTO support_access_grants (
          tenant_id,
          platform_user_id,
          scope_json,
          reason,
          expires_at,
          granted_by,
          created_at
        )
        SELECT
          ${request.tenant_id},
          ${request.platform_user_id},
          ${JSON.stringify(scope)}::text::jsonb,
          ${request.reason},
          ${expiresAt.toISOString()},
          ${grantedBy},
          access_clock.created_at
        FROM access_clock
        WHERE
          ${expiresAt.toISOString()}::timestamptz > access_clock.created_at
          AND ${expiresAt.toISOString()}::timestamptz
            <= access_clock.created_at + interval '8 hours'
        RETURNING
          id,
          tenant_id AS "tenantId",
          platform_user_id AS "platformUserId",
          scope_json AS scope,
          reason,
          expires_at AS "expiresAt",
          revoked_at AS "revokedAt",
          granted_by AS "grantedBy",
          created_at AS "createdAt"
      `;
      const grant = rows[0];
      if (!grant) throw new SupportAccessValidationError();
      const view = toSupportGrantView(grant);
      await insertAuditEvent(transaction, {
        action: 'support_access.grant.created',
        actorUserId: grantedBy,
        after: {
          expires_at: view.expires_at,
          platform_user_id: view.platform_user_id,
          scope: view.scope,
        },
        audit,
        grantId: grant.id,
        resourceId: grant.id,
        resourceType: 'support_access_grant',
        tenantId: grant.tenantId,
      });
      return view;
    });
  }

  public async withTenantAccess<T>(
    input: SupportAccessOperationInput,
    operation: (transaction: TransactionSql, context: AuthorizedSupportAccess) => Promise<T>,
  ): Promise<T> {
    assertAuditValue(input.action, 80);
    assertAuditValue(input.resourceType, 64);
    assertAuditValue(input.requestId, 80);
    if (!isTenantPermission(input.permission)) throw new SupportAccessValidationError();

    const result = await this.database.client.begin(async (transaction) => {
      const rows = await transaction<{ id: string }[]>`
        SELECT access_grant.id
        FROM support_access_grants AS access_grant
        JOIN tenants AS tenant ON tenant.id = access_grant.tenant_id
        JOIN users AS platform_user ON platform_user.id = access_grant.platform_user_id
        WHERE
          access_grant.id = ${input.grantId}
          AND access_grant.tenant_id = ${input.tenantId}
          AND access_grant.platform_user_id = ${input.actorUserId}
          AND access_grant.revoked_at IS NULL
          AND access_grant.expires_at > clock_timestamp()
          AND access_grant.scope_json @>
            ${JSON.stringify({ permissions: [input.permission] })}::text::jsonb
          AND (
            jsonb_exists(access_grant.scope_json->'resource_types', '*')
            OR jsonb_exists(
              access_grant.scope_json->'resource_types',
              ${input.resourceType}
            )
          )
          AND tenant.status = 'active'
          AND tenant.deleted_at IS NULL
          AND platform_user.status = 'active'
          AND platform_user.deleted_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM platform_roles AS platform_role
            WHERE
              platform_role.user_id = access_grant.platform_user_id
              AND platform_role.role_code = 'platform_admin'
              AND platform_role.status = 'active'
          )
        FOR UPDATE OF access_grant
      `;
      if (rows.length !== 1) throw new SupportAccessNotFoundError();
      const context: AuthorizedSupportAccess = Object.freeze({
        actorUserId: input.actorUserId,
        grantId: input.grantId,
        permission: input.permission,
        tenantId: input.tenantId,
      });
      await insertAuditEvent(transaction, {
        action: input.action,
        actorUserId: input.actorUserId,
        audit: {
          ...(input.ip === undefined ? {} : { ip: input.ip }),
          requestId: input.requestId,
        },
        grantId: input.grantId,
        ...(input.resourceId ? { resourceId: input.resourceId } : {}),
        resourceType: input.resourceType,
        tenantId: input.tenantId,
      });
      return { value: await operation(transaction, context) };
    });
    return result.value;
  }

  public async revokeGrant(
    actorUserId: string,
    grantId: string,
    audit: SupportAccessAuditContext,
  ): Promise<void> {
    await this.database.client.begin(async (transaction) => {
      const rows = await transaction<{ id: string; tenantId: string }[]>`
        UPDATE support_access_grants AS access_grant
        SET revoked_at = clock_timestamp()
        WHERE
          access_grant.id = ${grantId}
          AND access_grant.revoked_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM platform_roles AS platform_role
            JOIN users AS platform_user ON platform_user.id = platform_role.user_id
            WHERE
              platform_role.user_id = ${actorUserId}
              AND platform_role.role_code = 'platform_admin'
              AND platform_role.status = 'active'
              AND platform_user.status = 'active'
              AND platform_user.deleted_at IS NULL
          )
        RETURNING access_grant.id, access_grant.tenant_id AS "tenantId"
      `;
      const revoked = rows[0];
      if (!revoked) throw new SupportAccessNotFoundError();
      await insertAuditEvent(transaction, {
        action: 'support_access.grant.revoked',
        actorUserId,
        audit,
        grantId,
        resourceId: grantId,
        resourceType: 'support_access_grant',
        tenantId: revoked.tenantId,
      });
    });
  }
}

async function assertGrantTargetInTransaction(
  transaction: TransactionSql,
  grantedBy: string,
  platformUserId: string,
  tenantId: string,
): Promise<void> {
  const rows = await transaction<{ valid: boolean }[]>`
    SELECT true AS valid
    FROM tenants AS tenant
    WHERE
      tenant.id = ${tenantId}
      AND tenant.status = 'active'
      AND tenant.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM platform_roles AS role
        JOIN users AS identity_user ON identity_user.id = role.user_id
        WHERE
          role.user_id = ${grantedBy}
          AND role.role_code = 'platform_admin'
          AND role.status = 'active'
          AND identity_user.status = 'active'
          AND identity_user.deleted_at IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM platform_roles AS role
        JOIN users AS identity_user ON identity_user.id = role.user_id
        WHERE
          role.user_id = ${platformUserId}
          AND role.role_code = 'platform_admin'
          AND role.status = 'active'
          AND identity_user.status = 'active'
          AND identity_user.deleted_at IS NULL
      )
    FOR SHARE OF tenant
  `;
  if (rows.length !== 1) throw new SupportAccessNotFoundError();
}

interface AuditEventInput {
  readonly action: string;
  readonly actorUserId: string;
  readonly after?: unknown;
  readonly audit: SupportAccessAuditContext;
  readonly grantId: string;
  readonly resourceId?: string;
  readonly resourceType: string;
  readonly tenantId: string;
}

async function insertAuditEvent(
  transaction: TransactionSql,
  input: AuditEventInput,
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    INSERT INTO audit_events (
      tenant_id,
      actor_id,
      support_access_grant_id,
      action,
      resource_type,
      resource_id,
      after_json,
      ip,
      request_id
    ) VALUES (
      ${input.tenantId},
      ${input.actorUserId},
      ${input.grantId},
      ${input.action},
      ${input.resourceType},
      ${input.resourceId ?? null},
      ${input.after === undefined ? null : JSON.stringify(input.after)}::text::jsonb,
      ${input.audit.ip ?? null},
      ${input.audit.requestId}
    )
    RETURNING id
  `;
  if (rows.length !== 1) throw new Error('Required support-access audit write failed');
}

function toSupportGrantView(grant: SupportGrantRow): SupportGrantView {
  const now = Date.now();
  return {
    created_at: toIso(grant.createdAt),
    expires_at: toIso(grant.expiresAt),
    granted_by: grant.grantedBy,
    id: grant.id,
    platform_user_id: grant.platformUserId,
    reason: grant.reason,
    revoked_at: grant.revokedAt ? toIso(grant.revokedAt) : null,
    scope: grant.scope,
    status: grant.revokedAt
      ? 'revoked'
      : new Date(grant.expiresAt).getTime() <= now
        ? 'expired'
        : 'active',
    tenant_id: grant.tenantId,
  };
}

function assertAuditValue(value: string, maximumLength: number): void {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new SupportAccessValidationError();
  }
}

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}
