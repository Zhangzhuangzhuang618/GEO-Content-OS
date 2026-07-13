import type { TenantRoleCode } from '@geo-content-os/contracts';

import type { DatabaseClient } from '../../../database/index.js';

export interface IdentityUserView {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: 'invited' | 'active' | 'disabled';
  readonly lastLoginAt: Date | null;
}

export interface AuthenticationUser extends IdentityUserView {
  readonly passwordHash: string | null;
  readonly passwordChangedAt: Date | null;
}

export interface ActiveMembershipView {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tenantSlug: string;
  readonly roleCode: TenantRoleCode;
  readonly updatedAt: Date;
}

export class IdentityRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async findUserByEmail(email: string): Promise<IdentityUserView | undefined> {
    const rows = await this.client<IdentityUserView[]>`
      SELECT
        id,
        email::text AS email,
        display_name AS "displayName",
        status,
        last_login_at AS "lastLoginAt"
      FROM users
      WHERE email = ${email} AND deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0];
  }

  public async findAuthenticationUserByEmail(
    email: string,
  ): Promise<AuthenticationUser | undefined> {
    const rows = await this.client<AuthenticationUser[]>`
      SELECT
        id,
        email::text AS email,
        display_name AS "displayName",
        status,
        last_login_at AS "lastLoginAt",
        password_hash AS "passwordHash",
        password_changed_at AS "passwordChangedAt"
      FROM users
      WHERE email = ${email} AND deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0];
  }

  public async findActiveMembership(
    userId: string,
    tenantId: string,
  ): Promise<ActiveMembershipView | undefined> {
    const rows = await this.client<ActiveMembershipView[]>`
      SELECT
        membership.id,
        membership.tenant_id AS "tenantId",
        tenant.name AS "tenantName",
        tenant.slug::text AS "tenantSlug",
        membership.role_code AS "roleCode",
        membership.updated_at AS "updatedAt"
      FROM memberships AS membership
      JOIN tenants AS tenant ON tenant.id = membership.tenant_id
      WHERE
        membership.user_id = ${userId}
        AND membership.tenant_id = ${tenantId}
        AND membership.status = 'active'
        AND tenant.status = 'active'
        AND tenant.deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0];
  }

  public async listActiveTenantChoices(userId: string): Promise<readonly ActiveMembershipView[]> {
    return this.client<ActiveMembershipView[]>`
      SELECT
        membership.id,
        membership.tenant_id AS "tenantId",
        tenant.name AS "tenantName",
        tenant.slug::text AS "tenantSlug",
        membership.role_code AS "roleCode",
        membership.updated_at AS "updatedAt"
      FROM memberships AS membership
      JOIN tenants AS tenant ON tenant.id = membership.tenant_id
      WHERE
        membership.user_id = ${userId}
        AND membership.status = 'active'
        AND tenant.status = 'active'
        AND tenant.deleted_at IS NULL
      ORDER BY membership.updated_at DESC, membership.id
    `;
  }
}
