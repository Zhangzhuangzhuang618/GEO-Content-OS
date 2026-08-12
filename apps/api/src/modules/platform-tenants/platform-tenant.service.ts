import type { EmailAdapter, InvitationEmail } from '@geo-content-os/adapter-email';
import type {
  CreateTenantRequest,
  PlatformTenantView,
  TenantListQuery,
  TenantStatus,
} from '@geo-content-os/contracts';
import { generateSecureToken } from '@geo-content-os/security';
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';

import { IdentityAuthDatabase } from '../identity/auth/auth.database.js';
import { IDENTITY_EMAIL_ADAPTER } from '../identity/email/email.module.js';
import { readInvitationConfiguration } from '../identity/invitations/index.js';
import {
  PlatformTenantConflictError,
  PlatformTenantNotFoundError,
  PlatformTenantStateError,
  PlatformTenantVersionError,
} from './platform-tenant.errors.js';

interface TenantCursor {
  readonly createdAt: string;
  readonly id: string;
}

interface TenantRow {
  readonly checkedAt: Date | string;
  readonly createdAt: Date | string;
  readonly id: string;
  readonly ledgerEntries: number;
  readonly name: string;
  readonly periodEnd: Date | string;
  readonly periodStart: Date | string;
  readonly planCode: string;
  readonly settledCostCents: number;
  readonly slug: string;
  readonly status: TenantStatus;
  readonly timezone: string;
  readonly updatedAt: Date | string;
  readonly version: number;
}

interface ActorRow {
  readonly displayName: string;
}

interface OwnerRow {
  readonly id: string;
  readonly status: 'active' | 'disabled' | 'invited';
}

interface PendingOwnerInvitationRow {
  readonly email: string;
  readonly invitationId: string;
  readonly workspaceScope: unknown;
}

export interface PlatformTenantPage {
  readonly items: readonly PlatformTenantView[];
  readonly nextCursor: string | null;
}

export interface PlatformTenantAuditContext {
  readonly ip?: string;
  readonly requestId: string;
}

@Injectable()
export class PlatformTenantService {
  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
    @Inject(IDENTITY_EMAIL_ADAPTER) private readonly emailAdapter: EmailAdapter,
  ) {}

  public async list(query: TenantListQuery): Promise<PlatformTenantPage> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await queryTenants(this.database.client, {
      limit: query.limit + 1,
      ...(cursor ? { cursor } : {}),
      ...(query.plan_code ? { planCode: query.plan_code } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(query.status ? { status: query.status } : {}),
    });
    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(toTenantView),
      nextCursor:
        hasMore && last ? encodeCursor({ createdAt: toIso(last.createdAt), id: last.id }) : null,
    };
  }

  public async create(
    transaction: TransactionSql,
    actorUserId: string,
    request: CreateTenantRequest,
    audit: PlatformTenantAuditContext,
  ): Promise<PlatformTenantView> {
    const token = generateSecureToken(32);
    const ttlSeconds = readInvitationConfiguration().ttlSeconds;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1_000);
    try {
      const actors = await transaction<ActorRow[]>`
        SELECT identity_user.display_name AS "displayName"
        FROM users AS identity_user
        JOIN platform_roles AS platform_role ON platform_role.user_id = identity_user.id
        WHERE
          identity_user.id = ${actorUserId}::uuid
          AND identity_user.status = 'active'
          AND identity_user.deleted_at IS NULL
          AND platform_role.role_code = 'platform_admin'
          AND platform_role.status = 'active'
        LIMIT 1
      `;
      const actor = actors[0];
      if (!actor) throw new PlatformTenantNotFoundError();

      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${`tenant:${request.slug}`}, 0))`;
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${`user:${request.owner_email.toLowerCase()}`}, 0))`;

      const ownerRows = await transaction<OwnerRow[]>`
        SELECT id, status
        FROM users
        WHERE email = ${request.owner_email} AND deleted_at IS NULL
        FOR UPDATE
      `;
      let owner = ownerRows[0];
      if (owner?.status === 'disabled') throw new PlatformTenantConflictError();
      if (!owner) {
        const createdOwners = await transaction<OwnerRow[]>`
          INSERT INTO users (email, display_name, status)
          VALUES (${request.owner_email}, ${request.owner_display_name}, 'invited')
          RETURNING id, status
        `;
        owner = createdOwners[0];
      }
      if (!owner) throw new Error('Platform tenant owner insert returned no row');

      const tenants = await transaction<{ id: string }[]>`
        INSERT INTO tenants (name, slug, plan_code, timezone, status)
        VALUES (
          ${request.name}, ${request.slug}, ${request.plan_code}, ${request.timezone}, 'active'
        )
        RETURNING id
      `;
      const tenant = tenants[0];
      if (!tenant) throw new Error('Platform tenant insert returned no row');

      const workspaces = await transaction<{ id: string }[]>`
        INSERT INTO workspaces (tenant_id, name, slug, timezone, settings_json, status)
        VALUES (
          ${tenant.id}, ${request.default_workspace_name}, 'default', ${request.timezone},
          '{}'::jsonb, 'active'
        )
        RETURNING id
      `;
      const workspace = workspaces[0];
      if (!workspace) throw new Error('Default workspace insert returned no row');

      await transaction`
        INSERT INTO memberships (tenant_id, user_id, role_code, status, invited_by)
        VALUES (${tenant.id}, ${owner.id}, 'tenant_owner', 'invited', ${actorUserId})
      `;
      await transaction`
        INSERT INTO invitations (
          tenant_id, email, role_code, workspace_scope_json,
          token_hash, expires_at, invited_by
        ) VALUES (
          ${tenant.id}, ${request.owner_email}, 'tenant_owner',
          ${JSON.stringify({ workspace_ids: [workspace.id] })}::text::jsonb,
          ${sha256(token)}, ${expiresAt.toISOString()}, ${actorUserId}
        )
      `;

      const row = await selectTenant(transaction, tenant.id);
      const view = toTenantView(row);
      await insertAudit(transaction, {
        action: 'platform.tenant.created',
        actorUserId,
        after: view,
        audit,
        tenantId: tenant.id,
      });
      await this.sendOwnerInvitation({
        email: request.owner_email,
        expiresAt: expiresAt.toISOString(),
        inviterName: actor.displayName,
        tenantName: request.name,
        token,
      });
      return view;
    } catch (error) {
      if (error instanceof PlatformTenantConflictError || isUniqueViolation(error)) {
        throw new PlatformTenantConflictError();
      }
      throw error;
    }
  }

  public async suspend(
    actorUserId: string,
    tenantId: string,
    expectedVersion: number,
    reason: string,
    audit: PlatformTenantAuditContext,
  ): Promise<PlatformTenantView> {
    return this.transition(actorUserId, tenantId, expectedVersion, 'suspended', reason, audit);
  }

  public async restore(
    actorUserId: string,
    tenantId: string,
    expectedVersion: number,
    audit: PlatformTenantAuditContext,
  ): Promise<PlatformTenantView> {
    return this.transition(actorUserId, tenantId, expectedVersion, 'active', undefined, audit);
  }

  public async resendOwnerInvitation(
    transaction: TransactionSql,
    actorUserId: string,
    tenantId: string,
    audit: PlatformTenantAuditContext,
  ): Promise<PlatformTenantView> {
    const token = generateSecureToken(32);
    const ttlSeconds = readInvitationConfiguration().ttlSeconds;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1_000);
    const tenant = await lockTenant(transaction, tenantId);
    if (tenant.status !== 'active') throw new PlatformTenantStateError();

    const actors = await transaction<ActorRow[]>`
      SELECT identity_user.display_name AS "displayName"
      FROM users AS identity_user
      JOIN platform_roles AS platform_role ON platform_role.user_id = identity_user.id
      WHERE
        identity_user.id = ${actorUserId}::uuid
        AND identity_user.status = 'active'
        AND identity_user.deleted_at IS NULL
        AND platform_role.role_code = 'platform_admin'
        AND platform_role.status = 'active'
      LIMIT 1
    `;
    const actor = actors[0];
    if (!actor) throw new PlatformTenantNotFoundError();

    const invitations = await transaction<PendingOwnerInvitationRow[]>`
      SELECT
        identity_user.email::text AS email,
        invitation.id AS "invitationId",
        invitation.workspace_scope_json AS "workspaceScope"
      FROM memberships AS membership
      JOIN users AS identity_user
        ON identity_user.id = membership.user_id
        AND identity_user.status IN ('active', 'invited')
        AND identity_user.deleted_at IS NULL
      JOIN invitations AS invitation
        ON invitation.tenant_id = membership.tenant_id
        AND invitation.email = identity_user.email
        AND invitation.role_code = 'tenant_owner'
        AND invitation.accepted_at IS NULL
        AND invitation.revoked_at IS NULL
      WHERE
        membership.tenant_id = ${tenantId}::uuid
        AND membership.role_code = 'tenant_owner'
        AND membership.status = 'invited'
      ORDER BY invitation.created_at DESC, invitation.id DESC
      LIMIT 2
      FOR UPDATE OF membership, identity_user, invitation
    `;
    if (invitations.length !== 1) throw new PlatformTenantStateError();
    const previous = invitations[0];
    if (!previous) throw new PlatformTenantStateError();

    const revoked = await transaction<{ id: string }[]>`
      UPDATE invitations
      SET revoked_at = now()
      WHERE
        id = ${previous.invitationId}::uuid
        AND accepted_at IS NULL
        AND revoked_at IS NULL
      RETURNING id
    `;
    if (revoked.length !== 1) throw new PlatformTenantStateError();

    await transaction`
      INSERT INTO invitations (
        tenant_id, email, role_code, workspace_scope_json,
        token_hash, expires_at, invited_by
      ) VALUES (
        ${tenantId}::uuid, ${previous.email}, 'tenant_owner',
        ${JSON.stringify(previous.workspaceScope)}::text::jsonb,
        ${sha256(token)}, ${expiresAt.toISOString()}, ${actorUserId}::uuid
      )
    `;

    const view = toTenantView(await selectTenant(transaction, tenantId));
    await insertAudit(transaction, {
      action: 'platform.tenant.owner_invitation_resent',
      actorUserId,
      after: {
        expires_at: expiresAt.toISOString(),
        invitation_status: 'pending',
        owner_membership_status: 'invited',
      },
      audit,
      before: { invitation_status: 'pending', owner_membership_status: 'invited' },
      tenantId,
    });
    await this.sendOwnerInvitation({
      email: previous.email,
      expiresAt: expiresAt.toISOString(),
      inviterName: actor.displayName,
      tenantName: tenant.name,
      token,
    });
    return view;
  }

  private async transition(
    actorUserId: string,
    tenantId: string,
    expectedVersion: number,
    nextStatus: Extract<TenantStatus, 'active' | 'suspended'>,
    reason: string | undefined,
    audit: PlatformTenantAuditContext,
  ): Promise<PlatformTenantView> {
    return this.database.client.begin(async (transaction) => {
      const before = await lockTenant(transaction, tenantId);
      if (before.version !== expectedVersion) throw new PlatformTenantVersionError();
      const requiredStatus = nextStatus === 'suspended' ? 'active' : 'suspended';
      if (before.status !== requiredStatus) throw new PlatformTenantStateError();
      await transaction`
        UPDATE tenants
        SET status = ${nextStatus}, version = version + 1
        WHERE id = ${tenantId}::uuid AND deleted_at IS NULL
      `;
      const after = toTenantView(await selectTenant(transaction, tenantId));
      await insertAudit(transaction, {
        action:
          nextStatus === 'suspended' ? 'platform.tenant.suspended' : 'platform.tenant.restored',
        actorUserId,
        after: { ...after, ...(reason ? { reason } : {}) },
        audit,
        before: toTenantView(before),
        tenantId,
      });
      return after;
    });
  }

  private async sendOwnerInvitation(message: InvitationEmail): Promise<void> {
    await this.emailAdapter.sendInvitation(message);
  }
}

interface TenantQueryInput {
  readonly cursor?: TenantCursor;
  readonly limit: number;
  readonly planCode?: string;
  readonly search?: string;
  readonly status?: TenantStatus;
}

async function queryTenants(client: Sql | TransactionSql, input: TenantQueryInput) {
  return client<TenantRow[]>`
    SELECT
      tenant.id,
      tenant.name,
      tenant.slug::text AS slug,
      tenant.plan_code AS "planCode",
      tenant.timezone,
      tenant.status,
      tenant.version,
      tenant.created_at AS "createdAt",
      tenant.updated_at AS "updatedAt",
      usage.period_start AS "periodStart",
      usage.period_end AS "periodEnd",
      usage.settled_cost_cents AS "settledCostCents",
      usage.ledger_entries AS "ledgerEntries",
      clock_timestamp() AS "checkedAt"
    FROM tenants AS tenant
    CROSS JOIN LATERAL (
      SELECT
        date_trunc('month', now()) AS period_start,
        date_trunc('month', now()) + interval '1 month' AS period_end,
        COALESCE(sum(entry.cost_cents) FILTER (
          WHERE entry.status = 'settled'
            AND NOT EXISTS (
              SELECT 1 FROM usage_ledger AS reversal
              WHERE reversal.tenant_id = entry.tenant_id
                AND reversal.reverses_ledger_id = entry.id
                AND reversal.status = 'reversed'
            )
        ), 0)::integer AS settled_cost_cents,
        count(*) FILTER (
          WHERE entry.status = 'settled'
            AND NOT EXISTS (
              SELECT 1 FROM usage_ledger AS reversal
              WHERE reversal.tenant_id = entry.tenant_id
                AND reversal.reverses_ledger_id = entry.id
                AND reversal.status = 'reversed'
            )
        )::integer AS ledger_entries
      FROM usage_ledger AS entry
      WHERE
        entry.tenant_id = tenant.id
        AND entry.created_at >= date_trunc('month', now())
        AND entry.created_at < date_trunc('month', now()) + interval '1 month'
    ) AS usage
    WHERE
      tenant.deleted_at IS NULL
      AND (${input.search ?? null}::text IS NULL OR tenant.name ILIKE ${input.search ? `%${input.search}%` : null} OR tenant.slug::text ILIKE ${input.search ? `%${input.search}%` : null})
      AND (${input.status ?? null}::text IS NULL OR tenant.status = ${input.status ?? null})
      AND (${input.planCode ?? null}::text IS NULL OR tenant.plan_code = ${input.planCode ?? null})
      AND (
        ${input.cursor?.createdAt ?? null}::timestamptz IS NULL
        OR (tenant.created_at, tenant.id) < (
          ${input.cursor?.createdAt ?? null}::timestamptz,
          ${input.cursor?.id ?? null}::uuid
        )
      )
    ORDER BY tenant.created_at DESC, tenant.id DESC
    LIMIT ${input.limit}
  `;
}

async function selectTenant(client: Sql | TransactionSql, tenantId: string): Promise<TenantRow> {
  const rows = await queryTenantsById(client, tenantId);
  const row = rows[0];
  if (!row) throw new PlatformTenantNotFoundError();
  return row;
}

async function lockTenant(transaction: TransactionSql, tenantId: string): Promise<TenantRow> {
  const locked = await transaction<{ id: string }[]>`
    SELECT id FROM tenants
    WHERE id = ${tenantId}::uuid AND deleted_at IS NULL
    FOR UPDATE
  `;
  if (!locked[0]) throw new PlatformTenantNotFoundError();
  return selectTenant(transaction, tenantId);
}

async function queryTenantsById(
  client: Sql | TransactionSql,
  tenantId: string,
): Promise<TenantRow[]> {
  const rows = await client<TenantRow[]>`
    SELECT
      tenant.id,
      tenant.name,
      tenant.slug::text AS slug,
      tenant.plan_code AS "planCode",
      tenant.timezone,
      tenant.status,
      tenant.version,
      tenant.created_at AS "createdAt",
      tenant.updated_at AS "updatedAt",
      date_trunc('month', now()) AS "periodStart",
      date_trunc('month', now()) + interval '1 month' AS "periodEnd",
      COALESCE(sum(entry.cost_cents) FILTER (
        WHERE entry.status = 'settled'
          AND NOT EXISTS (
            SELECT 1 FROM usage_ledger AS reversal
            WHERE reversal.tenant_id = entry.tenant_id
              AND reversal.reverses_ledger_id = entry.id
              AND reversal.status = 'reversed'
          )
      ), 0)::integer AS "settledCostCents",
      count(*) FILTER (
        WHERE entry.status = 'settled'
          AND NOT EXISTS (
            SELECT 1 FROM usage_ledger AS reversal
            WHERE reversal.tenant_id = entry.tenant_id
              AND reversal.reverses_ledger_id = entry.id
              AND reversal.status = 'reversed'
          )
      )::integer AS "ledgerEntries",
      clock_timestamp() AS "checkedAt"
    FROM tenants AS tenant
    LEFT JOIN usage_ledger AS entry
      ON entry.tenant_id = tenant.id
      AND entry.created_at >= date_trunc('month', now())
      AND entry.created_at < date_trunc('month', now()) + interval '1 month'
    WHERE tenant.id = ${tenantId}::uuid AND tenant.deleted_at IS NULL
    GROUP BY tenant.id
  `;
  return rows;
}

interface AuditInput {
  readonly action: string;
  readonly actorUserId: string;
  readonly after: unknown;
  readonly audit: PlatformTenantAuditContext;
  readonly before?: unknown;
  readonly tenantId: string;
}

async function insertAudit(transaction: TransactionSql, input: AuditInput): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    INSERT INTO audit_events (
      tenant_id, actor_id, action, resource_type, resource_id,
      before_json, after_json, ip, request_id
    ) VALUES (
      ${input.tenantId}, ${input.actorUserId}, ${input.action}, 'tenant', ${input.tenantId},
      ${input.before === undefined ? null : JSON.stringify(input.before)}::text::jsonb,
      ${JSON.stringify(input.after)}::text::jsonb,
      ${input.audit.ip ?? null}, ${input.audit.requestId}
    )
    RETURNING id
  `;
  if (rows.length !== 1) throw new Error('Required platform tenant audit write failed');
}

function toTenantView(row: TenantRow): PlatformTenantView {
  return {
    created_at: toIso(row.createdAt),
    health: {
      checked_at: toIso(row.checkedAt),
      status:
        row.status === 'active' ? 'healthy' : row.status === 'suspended' ? 'suspended' : 'archived',
    },
    id: row.id,
    name: row.name,
    plan_code: row.planCode,
    slug: row.slug,
    status: row.status,
    timezone: row.timezone,
    updated_at: toIso(row.updatedAt),
    usage: {
      currency: 'CNY',
      ledger_entries: row.ledgerEntries,
      period_end: toIso(row.periodEnd),
      period_start: toIso(row.periodStart),
      settled_cost_cents: row.settledCostCents,
    },
    version: row.version,
  };
}

function encodeCursor(cursor: TenantCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): TenantCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as TenantCursor;
    if (!parsed.id || !parsed.createdAt || !Number.isFinite(Date.parse(parsed.createdAt))) {
      throw new Error('Invalid cursor');
    }
    return parsed;
  } catch {
    throw new PlatformTenantNotFoundError();
  }
}

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505');
}
