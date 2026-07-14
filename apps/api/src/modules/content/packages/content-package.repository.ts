import type { PlatformCode } from '@geo-content-os/contracts';
import type { TransactionSql } from 'postgres';

import type { DatabaseClient } from '../../../database/index.js';
import type {
  ContentPackageView,
  ContentScope,
  ContentVariantView,
} from '../repositories/index.js';
import {
  ContentPackageNotFoundError,
  ContentPackageStateError,
  ContentPackageVersionConflictError,
} from './content-package.errors.js';

interface PackageRow {
  readonly briefId: string;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly deletedAt: Date | null;
  readonly id: string;
  readonly masterContentVersionId: string | null;
  readonly projectId: string;
  readonly status: ContentPackageView['status'];
  readonly tenantId: string;
  readonly updatedAt: Date;
  readonly version: number;
  readonly workspaceId: string;
}

interface VariantRow {
  readonly createdAt: Date;
  readonly currentContentVersionId: string | null;
  readonly id: string;
  readonly isRequired: boolean;
  readonly packageId: string;
  readonly platformCode: PlatformCode;
  readonly qualityScore: string | null;
  readonly status: ContentVariantView['status'];
  readonly tenantId: string;
  readonly updatedAt: Date;
  readonly version: number;
}

interface BriefPackageSeed {
  readonly id: string;
  readonly platformCodes: readonly PlatformCode[];
}

export interface ContentMutationAudit {
  readonly ip?: string;
  readonly requestId: string;
}

export interface ContentPackageAggregate {
  readonly package: ContentPackageView;
  readonly variants: readonly ContentVariantView[];
}

/** Command/read repository for the Content Package aggregate root. */
export class ContentPackageRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async createFromBrief(
    transaction: TransactionSql,
    scope: ContentScope,
    briefId: string,
    audit: ContentMutationAudit,
  ): Promise<ContentPackageAggregate> {
    await assertContentProducer(transaction, scope.tenantId, scope.userId);
    const brief = await lockBriefSeed(transaction, scope, briefId);
    if (!brief) throw new ContentPackageNotFoundError();
    if (brief.platformCodes.length === 0 || brief.platformCodes.length > 7) {
      throw new ContentPackageStateError('Brief must select between one and seven platforms');
    }

    const packageRows = await transaction<PackageRow[]>`
      INSERT INTO content_packages (
        tenant_id,
        workspace_id,
        project_id,
        brief_id,
        created_by
      ) VALUES (
        ${scope.tenantId}::uuid,
        ${scope.workspaceId}::uuid,
        ${scope.projectId}::uuid,
        ${brief.id}::uuid,
        ${scope.userId}::uuid
      )
      RETURNING
        id,
        tenant_id AS "tenantId",
        workspace_id AS "workspaceId",
        project_id AS "projectId",
        brief_id AS "briefId",
        status,
        version,
        master_content_version_id AS "masterContentVersionId",
        created_by AS "createdBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt"
    `;
    const packageRow = packageRows[0];
    if (!packageRow) throw new Error('Content Package insert returned no row');
    const variantRows = await transaction<VariantRow[]>`
      INSERT INTO content_variants (
        tenant_id,
        package_id,
        platform_code,
        status,
        is_required
      )
      SELECT
        ${scope.tenantId}::uuid,
        ${packageRow.id}::uuid,
        selected.platform_code,
        'draft',
        true
      FROM unnest(${brief.platformCodes}::varchar[])
        WITH ORDINALITY AS selected(platform_code, ordinal)
      ORDER BY selected.ordinal
      RETURNING
        id,
        tenant_id AS "tenantId",
        package_id AS "packageId",
        platform_code AS "platformCode",
        current_content_version_id AS "currentContentVersionId",
        status,
        is_required AS "isRequired",
        quality_score::text AS "qualityScore",
        version,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;
    if (variantRows.length !== brief.platformCodes.length) {
      throw new Error('Content Package variant insert returned an incomplete platform set');
    }
    const aggregate = toAggregate(packageRow, variantRows);
    await insertContentAudit(transaction, {
      action: 'content_package.created',
      actorUserId: scope.userId,
      after: aggregate,
      audit,
      resourceId: packageRow.id,
      resourceType: 'content_package',
      tenantId: scope.tenantId,
    });
    return aggregate;
  }

  public async find(
    scope: ContentScope,
    packageId: string,
  ): Promise<ContentPackageAggregate | undefined> {
    const rows = await selectScopedPackages(this.client, scope, packageId);
    const packageRow = rows[0];
    if (!packageRow) return undefined;
    return toAggregate(packageRow, await selectVariants(this.client, scope.tenantId, packageId));
  }

  public async abandon(
    transaction: TransactionSql,
    scope: ContentScope,
    packageId: string,
    expectedVersion: number,
    reason: string,
    audit: ContentMutationAudit,
  ): Promise<ContentPackageAggregate> {
    await assertContentProducer(transaction, scope.tenantId, scope.userId);
    const normalizedReason = normalizeReason(reason);
    const beforePackage = await lockScopedPackage(transaction, scope, packageId);
    if (!beforePackage) throw new ContentPackageNotFoundError();
    if (beforePackage.version !== expectedVersion) {
      throw new ContentPackageVersionConflictError();
    }
    if (!['draft', 'all_failed'].includes(beforePackage.status)) {
      throw new ContentPackageStateError('Only draft or all-failed packages may be abandoned');
    }
    const beforeVariants = await lockVariants(transaction, scope.tenantId, packageId);
    if (beforeVariants.length === 0 || !beforeVariants.some((variant) => variant.isRequired)) {
      throw new ContentPackageStateError(
        'Content Package must retain at least one required variant',
      );
    }
    assertAbandonVariantSummary(beforePackage.status, beforeVariants);
    await assertNoActiveRuns(transaction, scope.tenantId, packageId);

    await transaction`
      UPDATE content_variants
      SET status = 'cancelled', version = version + 1
      WHERE tenant_id = ${scope.tenantId}::uuid
        AND package_id = ${packageId}::uuid
        AND status <> 'cancelled'
    `;
    const packageRows = await transaction<PackageRow[]>`
      UPDATE content_packages
      SET status = 'cancelled', version = version + 1
      WHERE id = ${packageId}::uuid
        AND tenant_id = ${scope.tenantId}::uuid
        AND version = ${expectedVersion}
        AND status IN ('draft', 'all_failed')
        AND deleted_at IS NULL
      RETURNING
        id,
        tenant_id AS "tenantId",
        workspace_id AS "workspaceId",
        project_id AS "projectId",
        brief_id AS "briefId",
        status,
        version,
        master_content_version_id AS "masterContentVersionId",
        created_by AS "createdBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt"
    `;
    const packageRow = packageRows[0];
    if (!packageRow) throw new ContentPackageVersionConflictError();
    const after = toAggregate(
      packageRow,
      await selectVariants(transaction, scope.tenantId, packageId),
    );
    await insertContentAudit(transaction, {
      action: 'content_package.abandoned',
      actorUserId: scope.userId,
      after,
      audit,
      before: toAggregate(beforePackage, beforeVariants),
      reason: normalizedReason,
      resourceId: packageId,
      resourceType: 'content_package',
      tenantId: scope.tenantId,
    });
    return after;
  }
}

async function lockBriefSeed(
  transaction: TransactionSql,
  scope: ContentScope,
  briefId: string,
): Promise<BriefPackageSeed | undefined> {
  const rows = await transaction<BriefPackageSeed[]>`
    SELECT brief.id, brief.platform_codes AS "platformCodes"
    FROM briefs AS brief
    JOIN projects AS project
      ON project.id = brief.project_id
      AND project.tenant_id = brief.tenant_id
      AND project.workspace_id = brief.workspace_id
      AND project.status = 'active'
      AND project.deleted_at IS NULL
    JOIN workspaces AS workspace
      ON workspace.id = brief.workspace_id
      AND workspace.tenant_id = brief.tenant_id
      AND workspace.status = 'active'
      AND workspace.deleted_at IS NULL
    WHERE brief.id = ${briefId}::uuid
      AND brief.tenant_id = ${scope.tenantId}::uuid
      AND brief.workspace_id = ${scope.workspaceId}::uuid
      AND brief.project_id = ${scope.projectId}::uuid
      AND brief.deleted_at IS NULL
      AND has_project_scope_access(
        brief.tenant_id,
        brief.workspace_id,
        brief.project_id,
        ${scope.userId}::uuid
      )
    FOR SHARE OF brief, project, workspace
  `;
  return rows[0];
}

async function selectScopedPackages(
  client: DatabaseClient,
  scope: ContentScope,
  packageId: string,
): Promise<PackageRow[]> {
  return client<PackageRow[]>`
    SELECT
      package.id,
      package.tenant_id AS "tenantId",
      package.workspace_id AS "workspaceId",
      package.project_id AS "projectId",
      package.brief_id AS "briefId",
      package.status,
      package.version,
      package.master_content_version_id AS "masterContentVersionId",
      package.created_by AS "createdBy",
      package.created_at AS "createdAt",
      package.updated_at AS "updatedAt",
      package.deleted_at AS "deletedAt"
    FROM content_packages AS package
    WHERE package.id = ${packageId}::uuid
      AND package.tenant_id = ${scope.tenantId}::uuid
      AND package.workspace_id = ${scope.workspaceId}::uuid
      AND package.project_id = ${scope.projectId}::uuid
      AND package.deleted_at IS NULL
      AND has_project_scope_access(
        package.tenant_id,
        package.workspace_id,
        package.project_id,
        ${scope.userId}::uuid
      )
    LIMIT 1
  `;
}

async function lockScopedPackage(
  transaction: TransactionSql,
  scope: ContentScope,
  packageId: string,
): Promise<PackageRow | undefined> {
  const rows = await transaction<PackageRow[]>`
    SELECT
      package.id,
      package.tenant_id AS "tenantId",
      package.workspace_id AS "workspaceId",
      package.project_id AS "projectId",
      package.brief_id AS "briefId",
      package.status,
      package.version,
      package.master_content_version_id AS "masterContentVersionId",
      package.created_by AS "createdBy",
      package.created_at AS "createdAt",
      package.updated_at AS "updatedAt",
      package.deleted_at AS "deletedAt"
    FROM content_packages AS package
    JOIN projects AS project
      ON project.id = package.project_id
      AND project.tenant_id = package.tenant_id
      AND project.workspace_id = package.workspace_id
      AND project.status = 'active'
      AND project.deleted_at IS NULL
    JOIN workspaces AS workspace
      ON workspace.id = package.workspace_id
      AND workspace.tenant_id = package.tenant_id
      AND workspace.status = 'active'
      AND workspace.deleted_at IS NULL
    WHERE package.id = ${packageId}::uuid
      AND package.tenant_id = ${scope.tenantId}::uuid
      AND package.workspace_id = ${scope.workspaceId}::uuid
      AND package.project_id = ${scope.projectId}::uuid
      AND package.deleted_at IS NULL
      AND has_project_scope_access(
        package.tenant_id,
        package.workspace_id,
        package.project_id,
        ${scope.userId}::uuid
      )
    FOR UPDATE OF package
  `;
  return rows[0];
}

async function selectVariants(
  client: DatabaseClient | TransactionSql,
  tenantId: string,
  packageId: string,
): Promise<VariantRow[]> {
  return client<VariantRow[]>`
    SELECT
      id,
      tenant_id AS "tenantId",
      package_id AS "packageId",
      platform_code AS "platformCode",
      current_content_version_id AS "currentContentVersionId",
      status,
      is_required AS "isRequired",
      quality_score::text AS "qualityScore",
      version,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM content_variants
    WHERE tenant_id = ${tenantId}::uuid AND package_id = ${packageId}::uuid
    ORDER BY platform_code, id
  `;
}

async function lockVariants(
  transaction: TransactionSql,
  tenantId: string,
  packageId: string,
): Promise<VariantRow[]> {
  return transaction<VariantRow[]>`
    SELECT
      id,
      tenant_id AS "tenantId",
      package_id AS "packageId",
      platform_code AS "platformCode",
      current_content_version_id AS "currentContentVersionId",
      status,
      is_required AS "isRequired",
      quality_score::text AS "qualityScore",
      version,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM content_variants
    WHERE tenant_id = ${tenantId}::uuid AND package_id = ${packageId}::uuid
    ORDER BY id
    FOR UPDATE
  `;
}

async function assertContentProducer(
  transaction: TransactionSql,
  tenantId: string,
  actorUserId: string,
): Promise<void> {
  const rows = await transaction<{ valid: boolean }[]>`
    SELECT true AS valid
    FROM memberships AS membership
    JOIN users AS identity_user ON identity_user.id = membership.user_id
    JOIN tenants AS tenant ON tenant.id = membership.tenant_id
    WHERE membership.tenant_id = ${tenantId}::uuid
      AND membership.user_id = ${actorUserId}::uuid
      AND membership.status = 'active'
      AND membership.role_code IN ('tenant_owner', 'tenant_admin', 'content_editor')
      AND identity_user.status = 'active'
      AND identity_user.deleted_at IS NULL
      AND tenant.status = 'active'
      AND tenant.deleted_at IS NULL
    LIMIT 1
    FOR SHARE OF membership, identity_user, tenant
  `;
  if (rows.length !== 1) throw new ContentPackageNotFoundError();
}

async function assertNoActiveRuns(
  transaction: TransactionSql,
  tenantId: string,
  packageId: string,
): Promise<void> {
  const active = await transaction<{ id: string }[]>`
    SELECT id
    FROM generation_runs
    WHERE tenant_id = ${tenantId}::uuid
      AND package_id = ${packageId}::uuid
      AND status IN ('queued', 'running')
    ORDER BY id
    LIMIT 1
    FOR UPDATE
  `;
  if (active.length > 0) {
    throw new ContentPackageStateError(
      'A package with an active generation run cannot be abandoned',
    );
  }
}

interface AuditInput {
  readonly action:
    'content_package.abandoned' | 'content_package.created' | 'content_variant.dropped';
  readonly actorUserId: string;
  readonly after: unknown;
  readonly audit: ContentMutationAudit;
  readonly before?: unknown;
  readonly reason?: string;
  readonly resourceId: string;
  readonly resourceType: 'content_package' | 'content_variant';
  readonly tenantId: string;
}

export async function insertContentAudit(
  transaction: TransactionSql,
  input: AuditInput,
): Promise<void> {
  const after =
    input.reason === undefined ? input.after : { data: input.after, reason: input.reason };
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
      ${input.tenantId}::uuid,
      ${input.actorUserId}::uuid,
      ${input.action},
      ${input.resourceType},
      ${input.resourceId}::uuid,
      ${input.before === undefined ? null : JSON.stringify(input.before)}::text::jsonb,
      ${JSON.stringify(after)}::text::jsonb,
      ${input.audit.ip ?? null},
      ${input.audit.requestId}
    )
    RETURNING id
  `;
  if (rows.length !== 1) throw new Error('Required content aggregate audit write failed');
}

export function normalizeReason(value: string): string {
  const reason = value.trim();
  if (reason.length < 1 || reason.length > 1_000) {
    throw new ContentPackageStateError('Reason must contain between 1 and 1000 characters');
  }
  return reason;
}

function assertAbandonVariantSummary(
  packageStatus: ContentPackageView['status'],
  variants: readonly VariantRow[],
): void {
  const valid = variants.every((variant) => {
    if (!variant.isRequired) return variant.status === 'cancelled';
    return packageStatus === 'draft'
      ? variant.status === 'draft'
      : variant.status === 'generation_failed';
  });
  if (!valid) {
    throw new ContentPackageStateError(
      'Package summary and required Variant states do not permit abandonment',
    );
  }
}

function toAggregate(
  packageRow: PackageRow,
  variantRows: readonly VariantRow[],
): ContentPackageAggregate {
  return {
    package: { ...packageRow },
    variants: variantRows
      .map((variant) => ({ ...variant }))
      .sort(
        (left, right) =>
          left.platformCode.localeCompare(right.platformCode) || left.id.localeCompare(right.id),
      ),
  };
}
