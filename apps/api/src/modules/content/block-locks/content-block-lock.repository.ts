import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';

import type { DatabaseClient } from '../../../database/index.js';
import type { ContentDocument } from '../../../database/schema/index.js';
import type { ContentMutationAudit } from '../packages/index.js';
import type { ContentBlockLockView, ContentScope } from '../repositories/index.js';
import {
  ContentBlockLockNotFoundError,
  ContentBlockLockStateError,
  ContentBlockLockValidationError,
  ContentBlockLockVersionConflictError,
  ContentBlockLockViolationError,
} from './content-block-lock.errors.js';

const BLOCK_KEY = /^[a-z0-9_-]{1,80}$/u;

export interface ContentBlockLockMutationResult {
  readonly lock: ContentBlockLockView;
  readonly variantVersion: number;
}

export interface ContentBlockUnlockResult {
  readonly lockId: string;
  readonly variantVersion: number;
}

interface LockableVariantRow {
  readonly currentContentVersionId: string | null;
  readonly editable: boolean;
  readonly id: string;
  readonly packageId: string;
  readonly version: number;
}

interface CurrentBlockRow {
  readonly blockKey: string;
  readonly id: string;
  readonly textHash: string;
}

/** Stable block-key locks and byte-exact regeneration validation. */
export class ContentBlockLockRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async list(
    scope: ContentScope,
    variantId: string,
  ): Promise<readonly ContentBlockLockView[]> {
    return this.client<ContentBlockLockView[]>`
      SELECT
        lock.id,
        lock.tenant_id AS "tenantId",
        lock.variant_id AS "variantId",
        lock.block_key AS "blockKey",
        lock.locked_content_hash AS "lockedContentHash",
        lock.locked_by AS "lockedBy",
        lock.reason,
        lock.created_at AS "createdAt",
        lock.updated_at AS "updatedAt"
      FROM content_block_locks AS lock
      JOIN content_variants AS variant
        ON variant.id = lock.variant_id AND variant.tenant_id = lock.tenant_id
      JOIN content_packages AS package
        ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
      WHERE lock.tenant_id = ${scope.tenantId}::uuid
        AND lock.variant_id = ${variantId}::uuid
        AND package.workspace_id = ${scope.workspaceId}::uuid
        AND package.project_id = ${scope.projectId}::uuid
        AND package.deleted_at IS NULL
        AND has_project_scope_access(
          package.tenant_id,
          package.workspace_id,
          package.project_id,
          ${scope.userId}::uuid
        )
      ORDER BY lock.block_key, lock.id
    `;
  }

  public async lock(
    transaction: TransactionSql,
    scope: ContentScope,
    variantId: string,
    blockId: string,
    expectedVersion: number,
    reason: string | null | undefined,
    audit: ContentMutationAudit,
  ): Promise<ContentBlockLockMutationResult> {
    assertExpectedVersion(expectedVersion);
    const normalizedReason = normalizeReason(reason);
    await assertContentProducer(transaction, scope);
    const variant = await lockVariant(transaction, scope, variantId);
    assertMutableVariant(variant, expectedVersion);
    const block = await findCurrentBlock(transaction, scope.tenantId, variant, blockId);
    if (!block) throw new ContentBlockLockNotFoundError();

    const existing = await transaction<{ id: string }[]>`
      SELECT id
      FROM content_block_locks
      WHERE tenant_id = ${scope.tenantId}::uuid
        AND variant_id = ${variantId}::uuid
        AND block_key = ${block.blockKey}
      LIMIT 1
      FOR UPDATE
    `;
    if (existing.length > 0) {
      throw new ContentBlockLockStateError('The current block is already locked');
    }

    const rows = await transaction<ContentBlockLockView[]>`
      INSERT INTO content_block_locks (
        tenant_id,
        variant_id,
        block_key,
        locked_content_hash,
        locked_by,
        reason
      ) VALUES (
        ${scope.tenantId}::uuid,
        ${variantId}::uuid,
        ${block.blockKey},
        ${block.textHash},
        ${scope.userId}::uuid,
        ${normalizedReason}
      )
      RETURNING
        id,
        tenant_id AS "tenantId",
        variant_id AS "variantId",
        block_key AS "blockKey",
        locked_content_hash AS "lockedContentHash",
        locked_by AS "lockedBy",
        reason,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;
    const row = rows[0];
    if (!row) throw new Error('Content Block Lock insert did not return a row');
    const variantVersion = await incrementVariantVersion(
      transaction,
      scope.tenantId,
      variant,
      expectedVersion,
    );
    await insertLockAudit(transaction, {
      action: 'content_block.locked',
      actorUserId: scope.userId,
      after: { ...row, variant_version: variantVersion },
      audit,
      resourceId: row.id,
      tenantId: scope.tenantId,
    });
    return { lock: { ...row }, variantVersion };
  }

  public async unlock(
    transaction: TransactionSql,
    scope: ContentScope,
    variantId: string,
    blockId: string,
    expectedVersion: number,
    audit: ContentMutationAudit,
  ): Promise<ContentBlockUnlockResult> {
    assertExpectedVersion(expectedVersion);
    await assertContentProducer(transaction, scope);
    const variant = await lockVariant(transaction, scope, variantId);
    assertMutableVariant(variant, expectedVersion);
    const block = await findCurrentBlock(transaction, scope.tenantId, variant, blockId);
    if (!block) throw new ContentBlockLockNotFoundError();

    const rows = await transaction<ContentBlockLockView[]>`
      DELETE FROM content_block_locks
      WHERE tenant_id = ${scope.tenantId}::uuid
        AND variant_id = ${variantId}::uuid
        AND block_key = ${block.blockKey}
      RETURNING
        id,
        tenant_id AS "tenantId",
        variant_id AS "variantId",
        block_key AS "blockKey",
        locked_content_hash AS "lockedContentHash",
        locked_by AS "lockedBy",
        reason,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;
    const row = rows[0];
    if (!row) throw new ContentBlockLockNotFoundError();
    const variantVersion = await incrementVariantVersion(
      transaction,
      scope.tenantId,
      variant,
      expectedVersion,
    );
    await insertLockAudit(transaction, {
      action: 'content_block.unlocked',
      actorUserId: scope.userId,
      after: { block_key: row.blockKey, variant_version: variantVersion },
      audit,
      before: row,
      resourceId: row.id,
      tenantId: scope.tenantId,
    });
    return { lockId: row.id, variantVersion };
  }

  public async assertRegenerationPreservesLocks(
    scope: ContentScope,
    variantId: string,
    proposedContent: ContentDocument,
  ): Promise<readonly ContentBlockLockView[]> {
    const locks = await this.list(scope, variantId);
    if (locks.length === 0) {
      await assertReadableVariant(this.client, scope, variantId);
      return locks;
    }
    const proposed = extractProposedBlocks(proposedContent);
    for (const lock of locks) {
      if (proposed.get(lock.blockKey) !== lock.lockedContentHash) {
        throw new ContentBlockLockViolationError(lock.blockKey);
      }
    }
    return locks;
  }
}

async function assertReadableVariant(
  client: DatabaseClient,
  scope: ContentScope,
  variantId: string,
): Promise<void> {
  const rows = await client<{ id: string }[]>`
    SELECT variant.id
    FROM content_variants AS variant
    JOIN content_packages AS package
      ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
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
  if (rows.length !== 1) throw new ContentBlockLockNotFoundError();
}

async function lockVariant(
  transaction: TransactionSql,
  scope: ContentScope,
  variantId: string,
): Promise<LockableVariantRow | undefined> {
  const rows = await transaction<LockableVariantRow[]>`
    SELECT
      variant.id,
      variant.package_id AS "packageId",
      variant.current_content_version_id AS "currentContentVersionId",
      variant.version,
      package.status NOT IN ('cancelled', 'archived')
        AND variant.status <> 'cancelled' AS editable
    FROM content_variants AS variant
    JOIN content_packages AS package
      ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
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
    FOR UPDATE OF package, variant
  `;
  return rows[0];
}

async function findCurrentBlock(
  transaction: TransactionSql,
  tenantId: string,
  variant: LockableVariantRow,
  blockId: string,
): Promise<CurrentBlockRow | undefined> {
  if (!variant.currentContentVersionId) return undefined;
  const rows = await transaction<CurrentBlockRow[]>`
    SELECT
      id,
      block_key AS "blockKey",
      text_hash AS "textHash"
    FROM content_blocks
    WHERE id = ${blockId}::uuid
      AND tenant_id = ${tenantId}::uuid
      AND content_version_id = ${variant.currentContentVersionId}::uuid
    LIMIT 1
    FOR SHARE
  `;
  return rows[0];
}

async function assertContentProducer(
  transaction: TransactionSql,
  scope: ContentScope,
): Promise<void> {
  const rows = await transaction<{ valid: boolean }[]>`
    SELECT true AS valid
    FROM memberships AS membership
    JOIN users AS identity_user ON identity_user.id = membership.user_id
    JOIN tenants AS tenant ON tenant.id = membership.tenant_id
    WHERE membership.tenant_id = ${scope.tenantId}::uuid
      AND membership.user_id = ${scope.userId}::uuid
      AND membership.status = 'active'
      AND membership.role_code IN ('tenant_owner', 'tenant_admin', 'content_editor')
      AND identity_user.status = 'active'
      AND identity_user.deleted_at IS NULL
      AND tenant.status = 'active'
      AND tenant.deleted_at IS NULL
    LIMIT 1
    FOR SHARE OF membership, identity_user, tenant
  `;
  if (rows.length !== 1) throw new ContentBlockLockNotFoundError();
}

function assertMutableVariant(
  variant: LockableVariantRow | undefined,
  expectedVersion: number,
): asserts variant is LockableVariantRow {
  if (!variant) throw new ContentBlockLockNotFoundError();
  if (!variant.editable) {
    throw new ContentBlockLockStateError('Cancelled or archived content cannot change locks');
  }
  if (!variant.currentContentVersionId) {
    throw new ContentBlockLockStateError('A Variant without current content cannot lock blocks');
  }
  if (variant.version !== expectedVersion) throw new ContentBlockLockVersionConflictError();
}

async function incrementVariantVersion(
  transaction: TransactionSql,
  tenantId: string,
  variant: LockableVariantRow,
  expectedVersion: number,
): Promise<number> {
  const rows = await transaction<{ version: number }[]>`
    UPDATE content_variants
    SET version = version + 1
    WHERE id = ${variant.id}::uuid
      AND tenant_id = ${tenantId}::uuid
      AND package_id = ${variant.packageId}::uuid
      AND version = ${expectedVersion}
    RETURNING version
  `;
  const version = rows[0]?.version;
  if (!version) throw new ContentBlockLockVersionConflictError();
  return version;
}

function extractProposedBlocks(content: ContentDocument): ReadonlyMap<string, string> {
  const blocks = content.blocks;
  if (!Array.isArray(blocks) || blocks.length < 1) {
    throw new ContentBlockLockValidationError('Proposed content must contain structured blocks');
  }
  const hashes = new Map<string, string>();
  for (const [position, candidate] of blocks.entries()) {
    if (!isRecord(candidate)) {
      throw new ContentBlockLockValidationError(`Block at position ${position} must be an object`);
    }
    const blockKey = candidate.block_key;
    const text = candidate.text;
    if (typeof blockKey !== 'string' || !BLOCK_KEY.test(blockKey)) {
      throw new ContentBlockLockValidationError(
        `Block at position ${position} has an invalid block_key`,
      );
    }
    if (hashes.has(blockKey)) {
      throw new ContentBlockLockValidationError(`Duplicate block_key: ${blockKey}`);
    }
    if (typeof text !== 'string') {
      throw new ContentBlockLockValidationError(`Block ${blockKey} text must be a string`);
    }
    hashes.set(blockKey, sha256(text));
  }
  return hashes;
}

function normalizeReason(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const reason = value.trim();
  if (reason.length < 1 || reason.length > 1_000) {
    throw new ContentBlockLockValidationError(
      'Reason must contain between 1 and 1000 characters when provided',
    );
  }
  return reason;
}

interface LockAuditInput {
  readonly action: 'content_block.locked' | 'content_block.unlocked';
  readonly actorUserId: string;
  readonly after: unknown;
  readonly audit: ContentMutationAudit;
  readonly before?: unknown;
  readonly resourceId: string;
  readonly tenantId: string;
}

async function insertLockAudit(transaction: TransactionSql, input: LockAuditInput): Promise<void> {
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
      'content_block_lock',
      ${input.resourceId}::uuid,
      ${input.before === undefined ? null : JSON.stringify(input.before)}::text::jsonb,
      ${JSON.stringify(input.after)}::text::jsonb,
      ${input.audit.ip ?? null},
      ${input.audit.requestId}
    )
    RETURNING id
  `;
  if (rows.length !== 1) throw new Error('Required Content Block Lock audit write failed');
}

function assertExpectedVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ContentBlockLockValidationError('expectedVersion must be a positive integer');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
