import type { TenantRoleCode } from '@geo-content-os/contracts';
import { Inject, Injectable } from '@nestjs/common';

import type { SessionView } from '../auth/auth.dto.js';
import { IdentityAuthDatabase } from '../auth/auth.database.js';
import type { TenantChoice } from './tenant-context.dto.js';
import { TenantContextNotFoundError } from './tenant-context.errors.js';

interface TenantChoiceRow {
  readonly id: string;
  readonly lastUsedAt: Date | string | null;
  readonly name: string;
  readonly roleCode: TenantRoleCode;
  readonly slug: string;
}

interface SwitchedSessionRow {
  readonly activeTenantId: string;
  readonly displayName: string;
  readonly email: string;
  readonly expiresAt: Date | string;
  readonly userId: string;
}

@Injectable()
export class TenantContextService {
  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
  ) {}

  public async listAvailableTenants(
    userId: string,
    activeTenantId: string | null,
  ): Promise<TenantChoice[]> {
    const rows = await this.database.client<TenantChoiceRow[]>`
      SELECT
        tenant.id,
        tenant.name,
        tenant.slug::text AS slug,
        membership.role_code AS "roleCode",
        (
          SELECT max(session.last_seen_at)
          FROM sessions AS session
          WHERE
            session.user_id = membership.user_id
            AND session.active_tenant_id = membership.tenant_id
        ) AS "lastUsedAt"
      FROM memberships AS membership
      JOIN tenants AS tenant ON tenant.id = membership.tenant_id
      JOIN users AS identity_user ON identity_user.id = membership.user_id
      WHERE
        membership.user_id = ${userId}
        AND membership.status = 'active'
        AND tenant.status = 'active'
        AND tenant.deleted_at IS NULL
        AND identity_user.status = 'active'
        AND identity_user.deleted_at IS NULL
      ORDER BY "lastUsedAt" DESC NULLS LAST, tenant.name, tenant.id
    `;
    return rows.map((row) => ({
      id: row.id,
      is_active: row.id === activeTenantId,
      last_used_at: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : null,
      name: row.name,
      role_code: row.roleCode,
      slug: row.slug,
    }));
  }

  public async assertTenantAvailable(userId: string, tenantId: string): Promise<void> {
    const rows = await this.database.client<{ available: boolean }[]>`
      SELECT true AS available
      FROM memberships AS membership
      JOIN tenants AS tenant ON tenant.id = membership.tenant_id
      JOIN users AS identity_user ON identity_user.id = membership.user_id
      WHERE
        membership.user_id = ${userId}
        AND membership.tenant_id = ${tenantId}
        AND membership.status = 'active'
        AND tenant.status = 'active'
        AND tenant.deleted_at IS NULL
        AND identity_user.status = 'active'
        AND identity_user.deleted_at IS NULL
      LIMIT 1
    `;
    if (rows.length !== 1) throw new TenantContextNotFoundError();
  }

  public async switchTenant(
    sessionId: string,
    userId: string,
    tenantId: string,
  ): Promise<SessionView> {
    return this.database.client.begin(async (transaction) => {
      const rows = await transaction<SwitchedSessionRow[]>`
        UPDATE sessions AS session
        SET active_tenant_id = ${tenantId}, last_seen_at = now()
        FROM users AS identity_user
        WHERE
          session.id = ${sessionId}
          AND session.user_id = ${userId}
          AND session.user_id = identity_user.id
          AND session.revoked_at IS NULL
          AND session.expires_at > now()
          AND identity_user.status = 'active'
          AND identity_user.deleted_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM memberships AS membership
            JOIN tenants AS tenant ON tenant.id = membership.tenant_id
            WHERE
              membership.user_id = session.user_id
              AND membership.tenant_id = ${tenantId}
              AND membership.status = 'active'
              AND tenant.status = 'active'
              AND tenant.deleted_at IS NULL
          )
        RETURNING
          session.user_id AS "userId",
          session.active_tenant_id AS "activeTenantId",
          session.expires_at AS "expiresAt",
          identity_user.email::text AS email,
          identity_user.display_name AS "displayName"
      `;
      const switched = rows[0];
      if (!switched) throw new TenantContextNotFoundError();
      return {
        active_tenant_id: switched.activeTenantId,
        expires_at: new Date(switched.expiresAt).toISOString(),
        user: {
          display_name: switched.displayName,
          email: switched.email,
          id: switched.userId,
        },
      };
    });
  }
}
