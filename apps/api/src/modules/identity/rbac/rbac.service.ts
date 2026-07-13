import {
  permissionsForRoles,
  type PlatformRoleCode,
  type RoleCode,
  type TenantRoleCode,
} from '@geo-content-os/contracts';
import { Inject, Injectable } from '@nestjs/common';

import { IdentityAuthDatabase } from '../auth/auth.database.js';
import type { AuthSessionPrincipal } from '../auth/auth.service.js';
import type { PolicyContext } from './policy.types.js';

interface RoleRow {
  readonly roleCode: RoleCode;
  readonly roleScope: 'platform' | 'tenant';
}

@Injectable()
export class RbacService {
  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
  ) {}

  public async resolve(principal: AuthSessionPrincipal): Promise<PolicyContext> {
    const rows = await this.database.client<RoleRow[]>`
      SELECT
        platform_role.role_code AS "roleCode",
        'platform'::text AS "roleScope"
      FROM platform_roles AS platform_role
      JOIN users AS identity_user ON identity_user.id = platform_role.user_id
      WHERE
        platform_role.user_id = ${principal.userId}
        AND platform_role.status = 'active'
        AND identity_user.status = 'active'
        AND identity_user.deleted_at IS NULL
      UNION ALL
      SELECT
        membership.role_code AS "roleCode",
        'tenant'::text AS "roleScope"
      FROM memberships AS membership
      JOIN users AS identity_user ON identity_user.id = membership.user_id
      JOIN tenants AS tenant ON tenant.id = membership.tenant_id
      WHERE
        ${principal.activeTenantId}::uuid IS NOT NULL
        AND membership.user_id = ${principal.userId}
        AND membership.tenant_id = ${principal.activeTenantId}
        AND membership.status = 'active'
        AND tenant.status = 'active'
        AND tenant.deleted_at IS NULL
        AND identity_user.status = 'active'
        AND identity_user.deleted_at IS NULL
      ORDER BY "roleScope", "roleCode"
    `;
    const platformRoles = [
      ...new Set(
        rows
          .filter((row) => row.roleScope === 'platform')
          .map((row) => row.roleCode as PlatformRoleCode),
      ),
    ];
    const tenantRole =
      (rows.find((row) => row.roleScope === 'tenant')?.roleCode as TenantRoleCode | undefined) ??
      null;
    const roles: RoleCode[] = [...new Set([...platformRoles, ...(tenantRole ? [tenantRole] : [])])];
    return Object.freeze({
      activeTenantId: principal.activeTenantId,
      permissions: permissionsForRoles(roles),
      platformRoles: Object.freeze(platformRoles),
      roles: Object.freeze(roles),
      sessionId: principal.sessionId,
      tenantRole,
      userId: principal.userId,
    });
  }
}
