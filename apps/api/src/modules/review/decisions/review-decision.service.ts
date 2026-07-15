import {
  TENANT_ROLE_CODES,
  type ContentPackageStatus,
  type ContentVariantStatus,
  type TenantRoleCode,
  UuidSchema,
} from '@geo-content-os/contracts';
import type { TransactionSql } from 'postgres';

import type { DatabaseClient } from '../../../database/index.js';
import { RequiredAuditWriter } from '../../audit/index.js';
import { PackageStatusProjector } from '../../content/status/index.js';
import {
  ReviewRepository,
  type ReviewScope,
  type ReviewSnapshotStatus,
  type ReviewSnapshotView,
} from '../repositories/index.js';
import { ReviewDecisionError } from './review-decision.errors.js';
import type {
  RequestReviewSignoffRequest,
  ReviewDecisionRequest,
  ReviewDecisionResult,
  ReviewDecisionScope,
} from './review-decision.types.js';
import { assertReviewSnapshotIntegrity, type IntegritySnapshot } from './review-integrity.guard.js';

type DecisionKind = 'approve' | 'reject';

interface LockedSnapshot extends IntegritySnapshot {
  readonly packageStatus: ContentPackageStatus;
  readonly packageVersion: number;
  readonly status: ReviewSnapshotStatus;
  readonly version: number;
}

interface LockedVariant {
  readonly contentStatus: ContentVariantStatus;
  readonly contentVersion: number;
  readonly isRequired: boolean;
  readonly snapshotStatus: 'in_review' | 'approved' | 'rejected';
  readonly snapshotVariantId: string;
  readonly variantId: string;
}

interface ProjectionRow {
  readonly isRequired: boolean;
  readonly status: ContentVariantStatus;
}

const REVIEW_ROLES = new Set<TenantRoleCode>(['tenant_owner', 'tenant_admin', 'reviewer']);

export class ReviewDecisionService {
  private readonly projector = new PackageStatusProjector();

  public constructor(
    client: DatabaseClient,
    private readonly repository: ReviewRepository = new ReviewRepository(client),
    private readonly auditWriter: RequiredAuditWriter = new RequiredAuditWriter(),
  ) {}

  public approve(
    scope: ReviewDecisionScope,
    snapshotId: string,
    request: ReviewDecisionRequest,
    transaction?: TransactionSql,
  ): Promise<ReviewDecisionResult> {
    return this.decide(scope, snapshotId, request, 'approve', transaction);
  }

  public reject(
    scope: ReviewDecisionScope,
    snapshotId: string,
    request: ReviewDecisionRequest,
    transaction?: TransactionSql,
  ): Promise<ReviewDecisionResult> {
    return this.decide(scope, snapshotId, request, 'reject', transaction);
  }

  public async requestSignoff(
    scope: ReviewDecisionScope,
    snapshotId: string,
    request: RequestReviewSignoffRequest,
    providedTransaction?: TransactionSql,
  ): Promise<ReviewDecisionResult> {
    const variantIds = validateSignoff(scope, snapshotId, request);
    const work = async (transaction: TransactionSql): Promise<ReviewDecisionResult> => {
      const snapshot = await loadSnapshot(transaction, scope, snapshotId);
      const actorRole = await requireReviewRole(transaction, scope);
      assertActiveSnapshot(snapshot, request.expectedVersion);
      const variants = await lockVariants(transaction, snapshot);
      assertSelectedVariants(variants, variantIds);
      await assertReviewSnapshotIntegrity(transaction, snapshot);
      await assertSignoffTarget(transaction, scope.tenantId, request);
      await assertNoDuplicateRequirements(transaction, snapshot, variantIds, request);

      for (const variantId of variantIds) {
        await transaction`
          INSERT INTO review_requirements (
            tenant_id, snapshot_id, variant_id, required_role, required_user_id, requested_by
          ) VALUES (
            ${scope.tenantId}::uuid, ${snapshot.id}::uuid, ${variantId}::uuid,
            ${request.requiredRole ?? null}, ${request.requiredUserId ?? null}::uuid,
            ${scope.userId}::uuid
          )
        `;
      }
      await insertAction(
        transaction,
        scope,
        snapshot.id,
        'request_signoff',
        variantIds,
        normalizeComment(request.comment),
      );
      await updateSnapshotVersion(transaction, snapshot, 'in_review');
      await this.auditWriter.record(transaction, {
        action: 'review_snapshot.signoff_requested',
        actorId: scope.userId,
        after: {
          actor_role: actorRole,
          required_role: request.requiredRole ?? null,
          required_user_id: request.requiredUserId ?? null,
          variant_ids: variantIds,
        },
        before: { status: snapshot.status, version: snapshot.version },
        ip: scope.ip ?? null,
        requestId: scope.requestId,
        resourceId: snapshot.id,
        resourceType: 'review_snapshot',
        supportAccessGrantId: scope.supportAccessGrantId ?? null,
        tenantId: scope.tenantId,
      });
      return { snapshot: await readSnapshot(this.repository, transaction, scope, snapshot.id) };
    };
    return providedTransaction ? work(providedTransaction) : this.repository.withTransaction(work);
  }

  private async decide(
    scope: ReviewDecisionScope,
    snapshotId: string,
    request: ReviewDecisionRequest,
    decision: DecisionKind,
    providedTransaction?: TransactionSql,
  ): Promise<ReviewDecisionResult> {
    const variantIds = validateDecision(scope, snapshotId, request, decision);
    const work = async (transaction: TransactionSql): Promise<ReviewDecisionResult> => {
      const snapshot = await loadSnapshot(transaction, scope, snapshotId);
      const actorRole = await requireReviewRole(transaction, scope);
      assertActiveSnapshot(snapshot, request.expectedVersion);
      const variants = await lockVariants(transaction, snapshot);
      const selected = assertSelectedVariants(variants, variantIds);
      await assertReviewSnapshotIntegrity(transaction, snapshot);

      await insertAction(
        transaction,
        scope,
        snapshot.id,
        decision,
        variantIds,
        normalizeComment(request.comment),
      );
      if (decision === 'approve') {
        await applyApprovals(transaction, snapshot, selected, actorRole, scope.userId);
      } else {
        await applyRejections(transaction, snapshot, selected, actorRole, scope.userId);
      }

      const snapshotStatus = await projectSnapshotStatus(transaction, snapshot);
      await updateSnapshotVersion(transaction, snapshot, snapshotStatus);
      const packageStatus = await projectAndUpdatePackage(transaction, snapshot, this.projector);
      await this.auditWriter.record(transaction, {
        action: decision === 'approve' ? 'review_snapshot.approved' : 'review_snapshot.rejected',
        actorId: scope.userId,
        after: {
          actor_role: actorRole,
          package_status: packageStatus,
          snapshot_status: snapshotStatus,
          variant_ids: variantIds,
        },
        before: {
          package_status: snapshot.packageStatus,
          snapshot_status: snapshot.status,
          version: snapshot.version,
        },
        ip: scope.ip ?? null,
        requestId: scope.requestId,
        resourceId: snapshot.id,
        resourceType: 'review_snapshot',
        supportAccessGrantId: scope.supportAccessGrantId ?? null,
        tenantId: scope.tenantId,
      });
      return { snapshot: await readSnapshot(this.repository, transaction, scope, snapshot.id) };
    };
    return providedTransaction ? work(providedTransaction) : this.repository.withTransaction(work);
  }
}

async function loadSnapshot(
  transaction: TransactionSql,
  scope: ReviewDecisionScope,
  snapshotId: string,
): Promise<LockedSnapshot> {
  const rows = await transaction<LockedSnapshot[]>`
    SELECT
      snapshot.id,
      snapshot.tenant_id AS "tenantId",
      snapshot.snapshot_hash AS "snapshotHash",
      snapshot.brand_profile_id AS "brandProfileId",
      snapshot.prompt_version_id AS "promptVersionId",
      snapshot.model_key AS "modelKey",
      snapshot.platform_rules_hash AS "platformRulesHash",
      snapshot.quality_rules_hash AS "qualityRulesHash",
      snapshot.status,
      snapshot.version,
      package.status AS "packageStatus",
      package.version AS "packageVersion"
    FROM review_snapshots AS snapshot
    JOIN content_packages AS package
      ON package.id = snapshot.package_id AND package.tenant_id = snapshot.tenant_id
    WHERE snapshot.id = ${snapshotId}::uuid
      AND snapshot.tenant_id = ${scope.tenantId}::uuid
      AND package.workspace_id = ${scope.workspaceId}::uuid
      AND package.project_id = ${scope.projectId}::uuid
      AND package.deleted_at IS NULL
      AND has_project_scope_access(
        package.tenant_id, package.workspace_id, package.project_id, ${scope.userId}::uuid
      )
    LIMIT 1
    FOR UPDATE OF snapshot, package
  `;
  const row = rows[0];
  if (!row) notFound();
  return row;
}

async function requireReviewRole(
  transaction: TransactionSql,
  scope: ReviewDecisionScope,
): Promise<TenantRoleCode> {
  const rows = await transaction<{ roleCode: TenantRoleCode }[]>`
    SELECT membership.role_code AS "roleCode"
    FROM memberships AS membership
    JOIN users AS identity_user ON identity_user.id = membership.user_id
    JOIN tenants AS tenant ON tenant.id = membership.tenant_id
    WHERE membership.tenant_id = ${scope.tenantId}::uuid
      AND membership.user_id = ${scope.userId}::uuid
      AND membership.status = 'active'
      AND identity_user.status = 'active'
      AND identity_user.deleted_at IS NULL
      AND tenant.status = 'active'
      AND tenant.deleted_at IS NULL
    LIMIT 1
    FOR SHARE OF membership, identity_user, tenant
  `;
  const role = rows[0]?.roleCode;
  if (!role) notFound();
  if (!REVIEW_ROLES.has(role)) permissionDenied();
  return role;
}

async function lockVariants(
  transaction: TransactionSql,
  snapshot: LockedSnapshot,
): Promise<readonly LockedVariant[]> {
  return transaction<LockedVariant[]>`
    SELECT
      snapshot_variant.id AS "snapshotVariantId",
      snapshot_variant.variant_id AS "variantId",
      snapshot_variant.status AS "snapshotStatus",
      variant.status AS "contentStatus",
      variant.version AS "contentVersion",
      variant.is_required AS "isRequired"
    FROM review_snapshot_variants AS snapshot_variant
    JOIN content_variants AS variant
      ON variant.id = snapshot_variant.variant_id
      AND variant.tenant_id = snapshot_variant.tenant_id
    WHERE snapshot_variant.tenant_id = ${snapshot.tenantId}::uuid
      AND snapshot_variant.snapshot_id = ${snapshot.id}::uuid
    ORDER BY snapshot_variant.variant_id
    FOR UPDATE OF snapshot_variant, variant
  `;
}

function assertSelectedVariants(
  variants: readonly LockedVariant[],
  variantIds: readonly string[],
): readonly LockedVariant[] {
  const selected = variants.filter((variant) => variantIds.includes(variant.variantId));
  if (selected.length !== variantIds.length) notFound();
  if (selected.some((variant) => variant.snapshotStatus !== 'in_review')) {
    stateInvalid('Only in-review snapshot variants can receive review actions');
  }
  if (
    selected.some(
      (variant) =>
        variant.contentStatus !== 'in_review' && variant.contentStatus !== 'review_approved',
    )
  ) {
    stateInvalid('Selected content variants are no longer in an active review state');
  }
  return selected;
}

async function applyApprovals(
  transaction: TransactionSql,
  snapshot: LockedSnapshot,
  variants: readonly LockedVariant[],
  actorRole: TenantRoleCode,
  actorId: string,
): Promise<void> {
  const allVariantIds = await snapshotVariantIds(transaction, snapshot);
  const selectedIds = variants.map((variant) => variant.variantId);
  const coversSnapshot = selectedIds.length === allVariantIds.length;
  await transaction`
    UPDATE review_requirements
    SET status = 'approved', completed_at = now()
    WHERE tenant_id = ${snapshot.tenantId}::uuid
      AND snapshot_id = ${snapshot.id}::uuid
      AND status = 'pending'
      AND (required_user_id = ${actorId}::uuid OR required_role = ${actorRole})
      AND requested_by <> ${actorId}::uuid
      AND (
        variant_id = ANY(${selectedIds}::uuid[])
        OR (variant_id IS NULL AND ${coversSnapshot})
      )
  `;

  for (const variant of variants) {
    const pending = await countPendingRequirements(transaction, snapshot, variant.variantId);
    if (pending > 0) {
      if (variant.contentStatus === 'in_review') {
        await updateContentVariant(transaction, snapshot, variant, 'review_approved');
      }
      continue;
    }
    const snapshotVariants = await transaction<{ id: string }[]>`
      UPDATE review_snapshot_variants
      SET status = 'approved'
      WHERE id = ${variant.snapshotVariantId}::uuid
        AND tenant_id = ${snapshot.tenantId}::uuid
        AND status = 'in_review'
      RETURNING id
    `;
    if (snapshotVariants.length !== 1) versionConflict('Review variant state changed');
    if (variant.contentStatus === 'in_review') {
      const preapproved = await transaction<{ id: string }[]>`
        UPDATE content_variants SET status = 'review_approved'
        WHERE id = ${variant.variantId}::uuid
          AND tenant_id = ${snapshot.tenantId}::uuid
          AND status = 'in_review'
          AND version = ${variant.contentVersion}
        RETURNING id
      `;
      if (preapproved.length !== 1) {
        versionConflict('Content variant state changed during review');
      }
    }
    const approved = await transaction<{ id: string }[]>`
      UPDATE content_variants SET status = 'approved', version = version + 1
      WHERE id = ${variant.variantId}::uuid
        AND tenant_id = ${snapshot.tenantId}::uuid
        AND status = 'review_approved'
        AND version = ${variant.contentVersion}
      RETURNING id
    `;
    if (approved.length !== 1) versionConflict('Content variant state changed during review');
  }
}

async function applyRejections(
  transaction: TransactionSql,
  snapshot: LockedSnapshot,
  variants: readonly LockedVariant[],
  actorRole: TenantRoleCode,
  actorId: string,
): Promise<void> {
  const selectedIds = variants.map((variant) => variant.variantId);
  await transaction`
    UPDATE review_requirements
    SET
      status = CASE
        WHEN required_user_id = ${actorId}::uuid OR required_role = ${actorRole}
          THEN 'rejected'
        ELSE 'cancelled'
      END,
      completed_at = now()
    WHERE tenant_id = ${snapshot.tenantId}::uuid
      AND snapshot_id = ${snapshot.id}::uuid
      AND status = 'pending'
      AND variant_id = ANY(${selectedIds}::uuid[])
  `;
  for (const variant of variants) {
    const snapshotVariants = await transaction<{ id: string }[]>`
      UPDATE review_snapshot_variants SET status = 'rejected'
      WHERE id = ${variant.snapshotVariantId}::uuid
        AND tenant_id = ${snapshot.tenantId}::uuid
        AND status = 'in_review'
      RETURNING id
    `;
    if (snapshotVariants.length !== 1) versionConflict('Review variant state changed');
    await updateContentVariant(transaction, snapshot, variant, 'review_rejected');
  }
}

async function updateContentVariant(
  transaction: TransactionSql,
  snapshot: LockedSnapshot,
  variant: LockedVariant,
  status: 'review_approved' | 'review_rejected',
): Promise<void> {
  const updated = await transaction<{ id: string }[]>`
    UPDATE content_variants SET status = ${status}, version = version + 1
    WHERE id = ${variant.variantId}::uuid
      AND tenant_id = ${snapshot.tenantId}::uuid
      AND status = ${variant.contentStatus}
      AND version = ${variant.contentVersion}
    RETURNING id
  `;
  if (updated.length !== 1) versionConflict('Content variant state changed during review');
}

async function countPendingRequirements(
  transaction: TransactionSql,
  snapshot: LockedSnapshot,
  variantId: string,
): Promise<number> {
  const rows = await transaction<{ count: number }[]>`
    SELECT count(*)::integer AS count
    FROM review_requirements
    WHERE tenant_id = ${snapshot.tenantId}::uuid
      AND snapshot_id = ${snapshot.id}::uuid
      AND status = 'pending'
      AND (variant_id = ${variantId}::uuid OR variant_id IS NULL)
  `;
  return rows[0]?.count ?? 0;
}

async function snapshotVariantIds(
  transaction: TransactionSql,
  snapshot: LockedSnapshot,
): Promise<readonly string[]> {
  const rows = await transaction<{ variantId: string }[]>`
    SELECT variant_id AS "variantId"
    FROM review_snapshot_variants
    WHERE tenant_id = ${snapshot.tenantId}::uuid AND snapshot_id = ${snapshot.id}::uuid
    ORDER BY variant_id
  `;
  return rows.map((row) => row.variantId);
}

async function projectSnapshotStatus(
  transaction: TransactionSql,
  snapshot: LockedSnapshot,
): Promise<ReviewSnapshotStatus> {
  const rows = await transaction<{ status: 'in_review' | 'approved' | 'rejected' }[]>`
    SELECT status FROM review_snapshot_variants
    WHERE tenant_id = ${snapshot.tenantId}::uuid AND snapshot_id = ${snapshot.id}::uuid
  `;
  if (rows.length === 0) versionConflict('Review snapshot has no variants');
  if (rows.some((row) => row.status === 'in_review')) return 'in_review';
  return rows.every((row) => row.status === 'approved') ? 'approved' : 'rejected';
}

async function updateSnapshotVersion(
  transaction: TransactionSql,
  snapshot: LockedSnapshot,
  status: ReviewSnapshotStatus,
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    UPDATE review_snapshots SET status = ${status}, version = version + 1
    WHERE id = ${snapshot.id}::uuid
      AND tenant_id = ${snapshot.tenantId}::uuid
      AND version = ${snapshot.version}
    RETURNING id
  `;
  if (rows.length !== 1) versionConflict('Review snapshot version changed');
}

async function projectAndUpdatePackage(
  transaction: TransactionSql,
  snapshot: LockedSnapshot,
  projector: PackageStatusProjector,
): Promise<ContentPackageStatus> {
  const activeRows = await transaction<{ active: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM review_snapshots
      WHERE tenant_id = ${snapshot.tenantId}::uuid
        AND package_id = (
          SELECT package_id FROM review_snapshots
          WHERE id = ${snapshot.id}::uuid AND tenant_id = ${snapshot.tenantId}::uuid
        )
        AND status = 'in_review'
    ) AS active
  `;
  const variants = await transaction<ProjectionRow[]>`
    SELECT variant.status, variant.is_required AS "isRequired"
    FROM content_variants AS variant
    JOIN review_snapshots AS review ON review.package_id = variant.package_id
    WHERE review.id = ${snapshot.id}::uuid
      AND review.tenant_id = ${snapshot.tenantId}::uuid
      AND variant.tenant_id = review.tenant_id
    ORDER BY variant.id
  `;
  const status = projector.project({
    currentStatus: snapshot.packageStatus,
    hasActiveReview: activeRows[0]?.active ?? false,
    variants,
  });
  const updated = await transaction<{ id: string }[]>`
    UPDATE content_packages SET status = ${status}, version = version + 1
    WHERE id = (
      SELECT package_id FROM review_snapshots
      WHERE id = ${snapshot.id}::uuid AND tenant_id = ${snapshot.tenantId}::uuid
    )
      AND tenant_id = ${snapshot.tenantId}::uuid
      AND version = ${snapshot.packageVersion}
    RETURNING id
  `;
  if (updated.length !== 1) versionConflict('Content package version changed during review');
  return status;
}

async function assertSignoffTarget(
  transaction: TransactionSql,
  tenantId: string,
  request: RequestReviewSignoffRequest,
): Promise<void> {
  if (request.requiredRole) {
    if (!REVIEW_ROLES.has(request.requiredRole)) {
      inputInvalid('A required role must be able to make review decisions');
    }
    return;
  }
  const rows = await transaction<{ roleCode: TenantRoleCode }[]>`
    SELECT membership.role_code AS "roleCode"
    FROM memberships AS membership
    JOIN users AS identity_user ON identity_user.id = membership.user_id
    JOIN tenants AS tenant ON tenant.id = membership.tenant_id
    WHERE membership.tenant_id = ${tenantId}::uuid
      AND membership.user_id = ${request.requiredUserId!}::uuid
      AND membership.status = 'active'
      AND identity_user.status = 'active'
      AND identity_user.deleted_at IS NULL
      AND tenant.status = 'active'
      AND tenant.deleted_at IS NULL
    LIMIT 1
  `;
  if (!rows[0] || !REVIEW_ROLES.has(rows[0].roleCode)) {
    stateInvalid('The required user is not an active reviewer or tenant administrator');
  }
}

async function assertNoDuplicateRequirements(
  transaction: TransactionSql,
  snapshot: LockedSnapshot,
  variantIds: readonly string[],
  request: RequestReviewSignoffRequest,
): Promise<void> {
  const rows = await transaction<{ count: number }[]>`
    SELECT count(*)::integer AS count
    FROM review_requirements
    WHERE tenant_id = ${snapshot.tenantId}::uuid
      AND snapshot_id = ${snapshot.id}::uuid
      AND variant_id = ANY(${variantIds}::uuid[])
      AND status = 'pending'
      AND required_role IS NOT DISTINCT FROM ${request.requiredRole ?? null}
      AND required_user_id IS NOT DISTINCT FROM ${request.requiredUserId ?? null}::uuid
  `;
  if ((rows[0]?.count ?? 0) > 0) stateInvalid('The same signoff requirement is already pending');
}

async function insertAction(
  transaction: TransactionSql,
  scope: ReviewDecisionScope,
  snapshotId: string,
  action: 'approve' | 'reject' | 'request_signoff',
  variantIds: readonly string[],
  comment: string | null,
): Promise<void> {
  await transaction`
    INSERT INTO review_actions (
      tenant_id, snapshot_id, reviewer_id, action, variant_ids, comment
    ) VALUES (
      ${scope.tenantId}::uuid, ${snapshotId}::uuid, ${scope.userId}::uuid,
      ${action}, ${variantIds}::uuid[], ${comment}
    )
  `;
}

function assertActiveSnapshot(snapshot: LockedSnapshot, expectedVersion: number): void {
  if (snapshot.version !== expectedVersion) versionConflict('Review snapshot version changed');
  if (snapshot.status !== 'in_review') stateInvalid('Only active review snapshots accept actions');
}

function validateDecision(
  scope: ReviewDecisionScope,
  snapshotId: string,
  request: ReviewDecisionRequest,
  decision: DecisionKind,
): readonly string[] {
  const variantIds = validateCommon(scope, snapshotId, request.expectedVersion, request.variantIds);
  const comment = normalizeComment(request.comment);
  if (decision === 'reject' && !comment) inputInvalid('A rejection comment is required');
  return variantIds;
}

function validateSignoff(
  scope: ReviewDecisionScope,
  snapshotId: string,
  request: RequestReviewSignoffRequest,
): readonly string[] {
  const variantIds = validateCommon(scope, snapshotId, request.expectedVersion, request.variantIds);
  const hasRole = request.requiredRole !== undefined;
  const hasUser = request.requiredUserId !== undefined;
  if (hasRole === hasUser) inputInvalid('Exactly one required role or user must be supplied');
  if (request.requiredRole && !TENANT_ROLE_CODES.includes(request.requiredRole)) {
    inputInvalid('requiredRole is invalid');
  }
  if (request.requiredUserId && !UuidSchema.safeParse(request.requiredUserId).success) {
    inputInvalid('requiredUserId must be a UUID');
  }
  if (request.requiredUserId === scope.userId) {
    inputInvalid('A signoff must be requested from another reviewer');
  }
  normalizeComment(request.comment);
  return variantIds;
}

function validateCommon(
  scope: ReviewDecisionScope,
  snapshotId: string,
  expectedVersion: number,
  variantIds: readonly string[],
): readonly string[] {
  if (
    [scope.projectId, scope.tenantId, scope.userId, scope.workspaceId, snapshotId].some(
      (value) => !UuidSchema.safeParse(value).success,
    )
  ) {
    inputInvalid('Review scope and snapshot IDs must be UUIDs');
  }
  if (scope.requestId.trim().length < 1 || scope.requestId.trim().length > 80) {
    inputInvalid('requestId must contain 1 to 80 characters');
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    inputInvalid('expectedVersion must be a positive integer');
  }
  if (variantIds.length < 1 || variantIds.length > 7) {
    inputInvalid('variantIds must contain between 1 and 7 items');
  }
  if (variantIds.some((value) => !UuidSchema.safeParse(value).success)) {
    inputInvalid('Every variant ID must be a UUID');
  }
  const unique = [...new Set(variantIds)];
  if (unique.length !== variantIds.length) inputInvalid('variantIds must be unique');
  return unique.sort();
}

function normalizeComment(comment: string | null | undefined): string | null {
  if (comment === undefined || comment === null) return null;
  const normalized = comment.trim();
  if (normalized.length < 1 || normalized.length > 4000) {
    inputInvalid('comment must contain 1 to 4000 characters');
  }
  return normalized;
}

async function readSnapshot(
  repository: ReviewRepository,
  transaction: TransactionSql,
  scope: ReviewDecisionScope,
  snapshotId: string,
): Promise<ReviewSnapshotView> {
  const reviewScope: ReviewScope = {
    projectId: scope.projectId,
    tenantId: scope.tenantId,
    userId: scope.userId,
    workspaceId: scope.workspaceId,
  };
  const snapshot = await repository.findSnapshot(reviewScope, snapshotId, transaction);
  if (!snapshot) throw new Error('Updated review snapshot is not readable in its transaction');
  return snapshot;
}

function inputInvalid(message: string): never {
  throw new ReviewDecisionError('REVIEW_DECISION_INPUT_INVALID', message);
}

function notFound(): never {
  throw new ReviewDecisionError('REVIEW_DECISION_NOT_FOUND', 'Review snapshot was not found');
}

function permissionDenied(): never {
  throw new ReviewDecisionError(
    'REVIEW_DECISION_PERMISSION_DENIED',
    'The current member cannot make review decisions',
  );
}

function stateInvalid(message: string): never {
  throw new ReviewDecisionError('REVIEW_DECISION_STATE_INVALID', message);
}

function versionConflict(message: string): never {
  throw new ReviewDecisionError('REVIEW_DECISION_VERSION_CONFLICT', message);
}
