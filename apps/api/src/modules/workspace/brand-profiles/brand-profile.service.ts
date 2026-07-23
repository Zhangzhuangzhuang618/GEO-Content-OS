import type {
  BrandProfile,
  BrandProfileQuery,
  BrandProfileView,
  CreateBrandProfileRequest,
} from '@geo-content-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { Buffer } from 'node:buffer';
import type { TransactionSql } from 'postgres';

import { IdentityAuthDatabase } from '../../identity/auth/auth.database.js';
import {
  BrandProfileNotFoundError,
  BrandProfileStateError,
  BrandProfileValidationError,
  BrandProfileVersionConflictError,
} from './brand-profile.errors.js';

interface BrandProfileRow {
  readonly createdAt: Date | string;
  readonly createdBy: string;
  readonly cursorCreatedAt?: string;
  readonly id: string;
  readonly profile: BrandProfile;
  readonly publishedAt: Date | string | null;
  readonly schemaVersion: 'brand-profile@1';
  readonly status: 'draft' | 'published' | 'retired';
  readonly tenantId: string;
  readonly version: number;
  readonly workspaceId: string;
}

interface BrandProfileCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface BrandProfileAuditContext {
  readonly ip?: string;
  readonly requestId: string;
}

export interface BrandProfilePageResult {
  readonly items: readonly BrandProfileView[];
  readonly nextCursor: string | null;
}

@Injectable()
export class BrandProfileService {
  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
  ) {}

  public async create(
    transaction: TransactionSql,
    tenantId: string,
    actorUserId: string,
    input: CreateBrandProfileRequest,
    audit: BrandProfileAuditContext,
  ): Promise<BrandProfileView> {
    await assertBrandManager(transaction, tenantId, actorUserId);
    await lockBrandWorkspace(transaction, tenantId, input.workspace_id, actorUserId);
    await lockBrandVersionSequence(transaction, tenantId, input.workspace_id);
    const versions = await transaction<{ nextVersion: number }[]>`
      SELECT COALESCE(MAX(version), 0)::integer + 1 AS "nextVersion"
      FROM brand_profiles
      WHERE tenant_id = ${tenantId} AND workspace_id = ${input.workspace_id}
    `;
    const nextVersion = versions[0]?.nextVersion;
    if (!nextVersion) throw new Error('Brand profile version allocation failed');
    const rows = await transaction<BrandProfileRow[]>`
      INSERT INTO brand_profiles (
        tenant_id,
        workspace_id,
        version,
        status,
        schema_version,
        profile_json,
        created_by
      ) VALUES (
        ${tenantId},
        ${input.workspace_id},
        ${nextVersion},
        'draft',
        ${input.schema_version},
        ${JSON.stringify(input.profile)}::text::jsonb,
        ${actorUserId}
      )
      RETURNING
        id,
        tenant_id AS "tenantId",
        workspace_id AS "workspaceId",
        version,
        status,
        schema_version AS "schemaVersion",
        profile_json AS profile,
        created_by AS "createdBy",
        published_at AS "publishedAt",
        created_at AS "createdAt"
    `;
    const row = rows[0];
    if (!row) throw new Error('Brand profile insert returned no row');
    const view = toBrandProfileView(row);
    await insertBrandProfileAudit(transaction, {
      action: 'brand_profile.created',
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
    query: BrandProfileQuery,
  ): Promise<BrandProfilePageResult> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.database.client<BrandProfileRow[]>`
      SELECT
        profile.id,
        profile.tenant_id AS "tenantId",
        profile.workspace_id AS "workspaceId",
        profile.version,
        profile.status,
        profile.schema_version AS "schemaVersion",
        profile.profile_json AS profile,
        profile.created_by AS "createdBy",
        profile.published_at AS "publishedAt",
        profile.created_at AS "createdAt",
        profile.created_at::text AS "cursorCreatedAt"
      FROM brand_profiles AS profile
      JOIN workspaces AS workspace
        ON workspace.id = profile.workspace_id
        AND workspace.tenant_id = profile.tenant_id
        AND workspace.deleted_at IS NULL
      WHERE
        profile.tenant_id = ${tenantId}
        AND has_workspace_scope_access(
          profile.tenant_id,
          profile.workspace_id,
          ${userId}
        )
        AND (${query.workspace_id ?? null}::uuid IS NULL OR profile.workspace_id = ${query.workspace_id ?? null})
        AND (${query.status ?? null}::text IS NULL OR profile.status = ${query.status ?? null})
        AND (
          ${cursor?.createdAt ?? null}::timestamptz IS NULL
          OR (profile.created_at, profile.id) < (
            ${cursor?.createdAt ?? null}::timestamptz,
            ${cursor?.id ?? null}::uuid
          )
        )
      ORDER BY profile.created_at DESC, profile.id DESC
      LIMIT ${query.limit + 1}
    `;
    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(toBrandProfileView),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              createdAt: last.cursorCreatedAt ?? toIso(last.createdAt),
              id: last.id,
            })
          : null,
    };
  }

  public async find(
    tenantId: string,
    userId: string,
    profileId: string,
  ): Promise<BrandProfileView> {
    const rows = await this.database.client<BrandProfileRow[]>`
      SELECT
        profile.id,
        profile.tenant_id AS "tenantId",
        profile.workspace_id AS "workspaceId",
        profile.version,
        profile.status,
        profile.schema_version AS "schemaVersion",
        profile.profile_json AS profile,
        profile.created_by AS "createdBy",
        profile.published_at AS "publishedAt",
        profile.created_at AS "createdAt"
      FROM brand_profiles AS profile
      JOIN workspaces AS workspace
        ON workspace.id = profile.workspace_id
        AND workspace.tenant_id = profile.tenant_id
        AND workspace.deleted_at IS NULL
      WHERE
        profile.id = ${profileId}
        AND profile.tenant_id = ${tenantId}
        AND has_workspace_scope_access(
          profile.tenant_id,
          profile.workspace_id,
          ${userId}
        )
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw new BrandProfileNotFoundError();
    return toBrandProfileView(row);
  }

  public async publish(
    tenantId: string,
    actorUserId: string,
    profileId: string,
    expectedVersion: number,
    audit: BrandProfileAuditContext,
  ): Promise<BrandProfileView> {
    return this.database.client.begin(async (transaction) => {
      await assertBrandManager(transaction, tenantId, actorUserId);
      const metadata = await findBrandProfileMetadata(
        transaction,
        tenantId,
        actorUserId,
        profileId,
      );
      await lockBrandVersionSequence(transaction, tenantId, metadata.workspaceId);
      await lockBrandWorkspace(transaction, tenantId, metadata.workspaceId, actorUserId);
      const profiles = await lockBrandProfiles(transaction, tenantId, metadata.workspaceId);
      const target = profiles.find((profile) => profile.id === profileId);
      if (!target) throw new BrandProfileNotFoundError();
      if (target.version !== expectedVersion) throw new BrandProfileVersionConflictError();
      if (target.status === 'published') return toBrandProfileView(target);
      if (target.status !== 'draft') throw new BrandProfileStateError();

      const currentlyPublished = profiles.find((profile) => profile.status === 'published');
      if (currentlyPublished) {
        const retired = await updateBrandStatus(transaction, currentlyPublished.id, 'retired');
        await insertBrandProfileAudit(transaction, {
          action: 'brand_profile.retired',
          actorUserId,
          after: {
            ...toBrandProfileView(retired),
            reason: `Superseded by brand profile ${target.id}`,
          },
          audit,
          before: toBrandProfileView(currentlyPublished),
          resourceId: retired.id,
          tenantId,
        });
      }
      const publishedRows = await transaction<BrandProfileRow[]>`
        UPDATE brand_profiles
        SET status = 'published', published_at = now()
        WHERE id = ${profileId} AND tenant_id = ${tenantId} AND status = 'draft'
        RETURNING
          id,
          tenant_id AS "tenantId",
          workspace_id AS "workspaceId",
          version,
          status,
          schema_version AS "schemaVersion",
          profile_json AS profile,
          created_by AS "createdBy",
          published_at AS "publishedAt",
          created_at AS "createdAt"
      `;
      const published = publishedRows[0];
      if (!published) throw new BrandProfileStateError();
      const view = toBrandProfileView(published);
      await insertBrandProfileAudit(transaction, {
        action: 'brand_profile.published',
        actorUserId,
        after: view,
        audit,
        before: toBrandProfileView(target),
        resourceId: profileId,
        tenantId,
      });
      return view;
    });
  }

  public async retire(
    tenantId: string,
    actorUserId: string,
    profileId: string,
    expectedVersion: number,
    reason: string,
    audit: BrandProfileAuditContext,
  ): Promise<BrandProfileView> {
    return this.database.client.begin(async (transaction) => {
      await assertBrandManager(transaction, tenantId, actorUserId);
      const metadata = await findBrandProfileMetadata(
        transaction,
        tenantId,
        actorUserId,
        profileId,
      );
      await lockBrandVersionSequence(transaction, tenantId, metadata.workspaceId);
      await lockBrandWorkspace(transaction, tenantId, metadata.workspaceId, actorUserId);
      const profiles = await lockBrandProfiles(transaction, tenantId, metadata.workspaceId);
      const target = profiles.find((profile) => profile.id === profileId);
      if (!target) throw new BrandProfileNotFoundError();
      if (target.version !== expectedVersion) throw new BrandProfileVersionConflictError();
      if (target.status === 'retired') return toBrandProfileView(target);
      if (target.status !== 'published') throw new BrandProfileStateError();
      const retired = await updateBrandStatus(transaction, profileId, 'retired');
      const view = toBrandProfileView(retired);
      await insertBrandProfileAudit(transaction, {
        action: 'brand_profile.retired',
        actorUserId,
        after: { ...view, reason },
        audit,
        before: toBrandProfileView(target),
        resourceId: profileId,
        tenantId,
      });
      return view;
    });
  }
}

async function assertBrandManager(
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
  if (rows.length !== 1) throw new BrandProfileNotFoundError();
}

async function lockBrandWorkspace(
  transaction: TransactionSql,
  tenantId: string,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    SELECT id
    FROM workspaces
    WHERE
      id = ${workspaceId}
      AND tenant_id = ${tenantId}
      AND status = 'active'
      AND deleted_at IS NULL
      AND has_workspace_scope_access(tenant_id, id, ${userId})
    FOR SHARE
  `;
  if (rows.length !== 1) throw new BrandProfileNotFoundError();
}

async function findBrandProfileMetadata(
  transaction: TransactionSql,
  tenantId: string,
  userId: string,
  profileId: string,
): Promise<{ readonly workspaceId: string }> {
  const rows = await transaction<{ workspaceId: string }[]>`
    SELECT workspace_id AS "workspaceId"
    FROM brand_profiles
    WHERE
      id = ${profileId}
      AND tenant_id = ${tenantId}
      AND has_workspace_scope_access(tenant_id, workspace_id, ${userId})
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new BrandProfileNotFoundError();
  return row;
}

async function lockBrandVersionSequence(
  transaction: TransactionSql,
  tenantId: string,
  workspaceId: string,
): Promise<void> {
  await transaction`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`brand-profile:${tenantId}:${workspaceId}`}, 0)
    )
  `;
}

async function lockBrandProfiles(
  transaction: TransactionSql,
  tenantId: string,
  workspaceId: string,
): Promise<readonly BrandProfileRow[]> {
  return transaction<BrandProfileRow[]>`
    SELECT
      id,
      tenant_id AS "tenantId",
      workspace_id AS "workspaceId",
      version,
      status,
      schema_version AS "schemaVersion",
      profile_json AS profile,
      created_by AS "createdBy",
      published_at AS "publishedAt",
      created_at AS "createdAt"
    FROM brand_profiles
    WHERE tenant_id = ${tenantId} AND workspace_id = ${workspaceId}
    ORDER BY id
    FOR UPDATE
  `;
}

async function updateBrandStatus(
  transaction: TransactionSql,
  profileId: string,
  status: 'retired',
): Promise<BrandProfileRow> {
  const rows = await transaction<BrandProfileRow[]>`
    UPDATE brand_profiles
    SET status = ${status}
    WHERE id = ${profileId} AND status = 'published'
    RETURNING
      id,
      tenant_id AS "tenantId",
      workspace_id AS "workspaceId",
      version,
      status,
      schema_version AS "schemaVersion",
      profile_json AS profile,
      created_by AS "createdBy",
      published_at AS "publishedAt",
      created_at AS "createdAt"
  `;
  const row = rows[0];
  if (!row) throw new BrandProfileStateError();
  return row;
}

interface AuditInput {
  readonly action: string;
  readonly actorUserId: string;
  readonly after: unknown;
  readonly audit: BrandProfileAuditContext;
  readonly before?: unknown;
  readonly resourceId: string;
  readonly tenantId: string;
}

async function insertBrandProfileAudit(
  transaction: TransactionSql,
  input: AuditInput,
): Promise<void> {
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
      'brand_profile',
      ${input.resourceId},
      ${input.before === undefined ? null : JSON.stringify(input.before)}::text::jsonb,
      ${JSON.stringify(input.after)}::text::jsonb,
      ${input.audit.ip ?? null},
      ${input.audit.requestId}
    )
    RETURNING id
  `;
  if (rows.length !== 1) throw new Error('Required brand profile audit write failed');
}

function toBrandProfileView(row: BrandProfileRow): BrandProfileView {
  return {
    created_at: toIso(row.createdAt),
    created_by: row.createdBy,
    id: row.id,
    profile: row.profile,
    published_at: row.publishedAt ? toIso(row.publishedAt) : null,
    schema_version: row.schemaVersion,
    status: row.status,
    tenant_id: row.tenantId,
    version: row.version,
    workspace_id: row.workspaceId,
  };
}

function encodeCursor(cursor: BrandProfileCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): BrandProfileCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!isCursor(decoded)) throw new Error('Malformed brand profile cursor');
    return decoded;
  } catch {
    throw new BrandProfileValidationError('Brand profile cursor is invalid');
  }
}

function isCursor(value: unknown): value is BrandProfileCursor {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    typeof record['id'] === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      record['id'],
    ) &&
    typeof record['createdAt'] === 'string' &&
    Number.isFinite(new Date(record['createdAt']).getTime())
  );
}

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}
