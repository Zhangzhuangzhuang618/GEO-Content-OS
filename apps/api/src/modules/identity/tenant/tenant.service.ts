import type { TenantView, UpdateTenantRequest } from '@geo-content-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { TransactionSql } from 'postgres';

import { IdentityAuthDatabase } from '../auth/auth.database.js';
import {
  TenantNotFoundError,
  TenantValidationError,
  TenantVersionConflictError,
} from './tenant.errors.js';

interface TenantRow {
  readonly createdAt: Date | string;
  readonly id: string;
  readonly name: string;
  readonly planCode: string;
  readonly slug: string;
  readonly status: 'active' | 'archived' | 'suspended';
  readonly timezone: string;
  readonly updatedAt: Date | string;
  readonly version: number;
}

export interface TenantAuditContext {
  readonly ip?: string;
  readonly requestId: string;
}

@Injectable()
export class TenantService {
  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
  ) {}

  public async get(tenantId: string, actorUserId: string): Promise<TenantView> {
    const rows = await this.database.client<TenantRow[]>`
      SELECT
        tenant.id,
        tenant.name,
        tenant.slug::text AS slug,
        tenant.plan_code AS "planCode",
        tenant.timezone,
        tenant.status,
        tenant.version,
        tenant.created_at AS "createdAt",
        tenant.updated_at AS "updatedAt"
      FROM tenants AS tenant
      JOIN memberships AS membership ON membership.tenant_id = tenant.id
      WHERE
        tenant.id = ${tenantId}::uuid
        AND membership.user_id = ${actorUserId}::uuid
        AND membership.status = 'active'
        AND tenant.status = 'active'
        AND tenant.deleted_at IS NULL
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw new TenantNotFoundError();
    return toTenantView(row);
  }

  public async update(
    transaction: TransactionSql,
    tenantId: string,
    actorUserId: string,
    expectedVersion: number,
    input: UpdateTenantRequest,
    audit: TenantAuditContext,
  ): Promise<TenantView> {
    if (input.timezone !== undefined) assertTimeZone(input.timezone);
    const beforeRows = await transaction<TenantRow[]>`
      SELECT
        tenant.id,
        tenant.name,
        tenant.slug::text AS slug,
        tenant.plan_code AS "planCode",
        tenant.timezone,
        tenant.status,
        tenant.version,
        tenant.created_at AS "createdAt",
        tenant.updated_at AS "updatedAt"
      FROM tenants AS tenant
      JOIN memberships AS membership ON membership.tenant_id = tenant.id
      WHERE
        tenant.id = ${tenantId}::uuid
        AND membership.user_id = ${actorUserId}::uuid
        AND membership.role_code = 'tenant_owner'
        AND membership.status = 'active'
        AND tenant.status = 'active'
        AND tenant.deleted_at IS NULL
      FOR UPDATE OF tenant
    `;
    const before = beforeRows[0];
    if (!before) throw new TenantNotFoundError();
    if (before.version !== expectedVersion) throw new TenantVersionConflictError();

    const rows = await transaction<TenantRow[]>`
      UPDATE tenants
      SET
        name = COALESCE(${input.name ?? null}, name),
        timezone = COALESCE(${input.timezone ?? null}, timezone),
        version = version + 1,
        updated_at = clock_timestamp()
      WHERE id = ${tenantId}::uuid AND version = ${expectedVersion}
      RETURNING
        id,
        name,
        slug::text AS slug,
        plan_code AS "planCode",
        timezone,
        status,
        version,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;
    const row = rows[0];
    if (!row) throw new TenantVersionConflictError();
    const view = toTenantView(row);
    const auditRows = await transaction<{ id: string }[]>`
      INSERT INTO audit_events (
        tenant_id, actor_id, action, resource_type, resource_id,
        before_json, after_json, ip, request_id
      ) VALUES (
        ${tenantId}::uuid,
        ${actorUserId}::uuid,
        'tenant.updated',
        'tenant',
        ${tenantId}::uuid,
        ${JSON.stringify(toTenantView(before))}::text::jsonb,
        ${JSON.stringify(view)}::text::jsonb,
        ${audit.ip ?? null},
        ${audit.requestId}
      )
      RETURNING id
    `;
    if (auditRows.length !== 1) throw new Error('Required tenant audit write failed');
    return view;
  }
}

function toTenantView(row: TenantRow): TenantView {
  return {
    created_at: toIso(row.createdAt),
    id: row.id,
    name: row.name,
    plan_code: row.planCode,
    slug: row.slug,
    status: row.status,
    timezone: row.timezone,
    updated_at: toIso(row.updatedAt),
    version: row.version,
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertTimeZone(value: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
  } catch {
    throw new TenantValidationError('Tenant timezone must be a valid IANA timezone');
  }
}
