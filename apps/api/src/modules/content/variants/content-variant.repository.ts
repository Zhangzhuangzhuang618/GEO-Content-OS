import type {
  ContentPackageStatus,
  ContentVariantStatus,
  PlatformCode,
} from '@geo-content-os/contracts';
import type { TransactionSql } from 'postgres';

import type { DatabaseClient } from '../../../database/index.js';
import { insertContentAudit, type ContentMutationAudit } from '../packages/index.js';
import type { ContentScope, ContentVariantView } from '../repositories/index.js';
import {
  ContentVariantNotFoundError,
  ContentVariantStateError,
  ContentVariantVersionConflictError,
} from './content-variant.errors.js';

const DROP_PACKAGE_STATES = new Set<ContentPackageStatus>([
  'draft',
  'generated',
  'all_failed',
  'editing',
  'rejected',
  'approved',
  'publish_failed',
]);

const DROP_VARIANT_STATES = new Set<ContentVariantStatus>([
  'draft',
  'generation_failed',
  'generated',
  'quality_failed',
  'quality_passed',
  'review_rejected',
  'approved',
  'publish_failed',
]);

interface VariantRow {
  readonly createdAt: Date;
  readonly currentContentVersionId: string | null;
  readonly id: string;
  readonly isRequired: boolean;
  readonly packageId: string;
  readonly platformCode: PlatformCode;
  readonly qualityScore: string | null;
  readonly status: ContentVariantStatus;
  readonly tenantId: string;
  readonly updatedAt: Date;
  readonly version: number;
}

interface PackageStateRow {
  readonly id: string;
  readonly status: ContentPackageStatus;
}

/** Repository for single-platform Variant reads and aggregate-safe drop commands. */
export class ContentVariantRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async find(
    scope: ContentScope,
    variantId: string,
  ): Promise<ContentVariantView | undefined> {
    const rows = await this.client<VariantRow[]>`
      SELECT
        variant.id,
        variant.tenant_id AS "tenantId",
        variant.package_id AS "packageId",
        variant.platform_code AS "platformCode",
        variant.current_content_version_id AS "currentContentVersionId",
        variant.status,
        variant.is_required AS "isRequired",
        variant.quality_score::text AS "qualityScore",
        variant.version,
        variant.created_at AS "createdAt",
        variant.updated_at AS "updatedAt"
      FROM content_variants AS variant
      JOIN content_packages AS package
        ON package.id = variant.package_id
        AND package.tenant_id = variant.tenant_id
      WHERE variant.id = ${variantId}::uuid
        AND variant.tenant_id = ${scope.tenantId}::uuid
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
    return rows[0] ? { ...rows[0] } : undefined;
  }

  public async drop(
    transaction: TransactionSql,
    scope: ContentScope,
    packageId: string,
    variantId: string,
    expectedVersion: number,
    reason: string,
    audit: ContentMutationAudit,
  ): Promise<ContentVariantView> {
    await assertContentProducer(transaction, scope.tenantId, scope.userId);
    const normalizedReason = normalizeDropReason(reason);
    const packageState = await lockPackage(transaction, scope, packageId);
    if (!packageState) throw new ContentVariantNotFoundError();
    if (!DROP_PACKAGE_STATES.has(packageState.status)) {
      throw new ContentVariantStateError('Package state does not permit dropping a Variant');
    }
    const variants = await lockPackageVariants(transaction, scope.tenantId, packageId);
    const target = variants.find((variant) => variant.id === variantId);
    if (!target) throw new ContentVariantNotFoundError();
    if (target.version !== expectedVersion) throw new ContentVariantVersionConflictError();
    if (!target.isRequired || target.status === 'cancelled') {
      throw new ContentVariantStateError('Variant is already dropped');
    }
    if (!DROP_VARIANT_STATES.has(target.status)) {
      throw new ContentVariantStateError('Variant has an active workflow and cannot be dropped');
    }
    if (!variants.some((variant) => variant.id !== variantId && variant.isRequired)) {
      throw new ContentVariantStateError('At least one required Variant must remain');
    }
    await assertNoActiveRuns(transaction, scope.tenantId, packageId);

    const rows = await transaction<VariantRow[]>`
      UPDATE content_variants
      SET is_required = false, status = 'cancelled', version = version + 1
      WHERE id = ${variantId}::uuid
        AND tenant_id = ${scope.tenantId}::uuid
        AND package_id = ${packageId}::uuid
        AND version = ${expectedVersion}
        AND is_required
        AND status <> 'cancelled'
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
    const row = rows[0];
    if (!row) throw new ContentVariantVersionConflictError();
    const after = { ...row };
    await insertContentAudit(transaction, {
      action: 'content_variant.dropped',
      actorUserId: scope.userId,
      after,
      audit,
      before: { ...target },
      reason: normalizedReason,
      resourceId: variantId,
      resourceType: 'content_variant',
      tenantId: scope.tenantId,
    });
    return after;
  }
}

async function lockPackage(
  transaction: TransactionSql,
  scope: ContentScope,
  packageId: string,
): Promise<PackageStateRow | undefined> {
  const rows = await transaction<PackageStateRow[]>`
    SELECT package.id, package.status
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

async function lockPackageVariants(
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
  if (rows.length !== 1) throw new ContentVariantNotFoundError();
}

async function assertNoActiveRuns(
  transaction: TransactionSql,
  tenantId: string,
  packageId: string,
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    SELECT id
    FROM generation_runs
    WHERE tenant_id = ${tenantId}::uuid
      AND package_id = ${packageId}::uuid
      AND status IN ('queued', 'running')
    ORDER BY id
    LIMIT 1
    FOR UPDATE
  `;
  if (rows.length > 0) {
    throw new ContentVariantStateError(
      'A package with an active generation run cannot drop variants',
    );
  }
}

function normalizeDropReason(value: string): string {
  const reason = value.trim();
  if (reason.length < 1 || reason.length > 1_000) {
    throw new ContentVariantStateError('Reason must contain between 1 and 1000 characters');
  }
  return reason;
}
