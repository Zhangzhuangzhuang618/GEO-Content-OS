import type { PlatformCode } from '@geo-content-os/contracts';
import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';

import type { DatabaseClient } from '../../../database/index.js';
import type { ContentBlockType, ContentDocument } from '../../../database/schema/index.js';
import type { ContentMutationAudit } from '../packages/index.js';
import type { ContentBlockView, ContentScope, ContentVersionView } from '../repositories/index.js';
import {
  ContentVersionNotFoundError,
  ContentVersionStateError,
  ContentVersionValidationError,
  ContentVersionVersionConflictError,
} from './content-version.errors.js';

const BLOCK_KEY = /^[a-z0-9_-]{1,80}$/u;
const BLOCK_TYPES = new Set<ContentBlockType>([
  'heading',
  'paragraph',
  'list',
  'quote',
  'media',
  'cta',
]);

type JsonPrimitive = boolean | null | number | string;
export type ContentJsonValue =
  JsonPrimitive | readonly ContentJsonValue[] | { readonly [key: string]: ContentJsonValue };

export interface StructuredContentBlock {
  readonly block_key: string;
  readonly block_type: ContentBlockType;
  readonly text: string;
}

export interface ContentVersionDetail extends ContentVersionView {
  readonly blocks: readonly ContentBlockView[];
}

export interface CreateContentVersionInput {
  readonly contentJson: ContentDocument;
  readonly expectedVersion: number;
  readonly packageId: string;
  readonly schemaVersion: string;
  readonly sourceRunId?: string | null;
  readonly variantId: string | null;
}

export interface ContentBlockSnapshot {
  readonly blockKey: string;
  readonly blockType: ContentBlockType;
  readonly position: number;
  readonly text: string;
  readonly textHash: string;
}

export interface ContentBlockDiff {
  readonly after?: ContentBlockSnapshot;
  readonly before?: ContentBlockSnapshot;
  readonly blockKey: string;
  readonly change: 'added' | 'modified' | 'moved' | 'removed';
}

export interface ContentFieldDiff {
  readonly after?: ContentJsonValue;
  readonly before?: ContentJsonValue;
  readonly field: string;
}

export interface ContentVersionDiff {
  readonly base: Pick<ContentVersionView, 'contentHash' | 'id' | 'versionNo'>;
  readonly blocks: readonly ContentBlockDiff[];
  readonly fields: readonly ContentFieldDiff[];
  readonly target: Pick<ContentVersionView, 'contentHash' | 'id' | 'versionNo'>;
}

interface ContentObjectRow {
  readonly aggregateVersion: number;
  readonly currentContentVersionId: string | null;
  readonly editable: boolean;
  readonly packageId: string;
  readonly platformCode: PlatformCode | 'master';
  readonly variantId: string | null;
}

type VersionRow = ContentVersionView;

/** Immutable content history, structured block projection, diff, and pointer rollback. */
export class ContentVersionRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async find(
    scope: ContentScope,
    contentVersionId: string,
  ): Promise<ContentVersionDetail | undefined> {
    const rows = await this.client<VersionRow[]>`
      SELECT
        version.id,
        version.tenant_id AS "tenantId",
        version.package_id AS "packageId",
        version.variant_id AS "variantId",
        version.version_no AS "versionNo",
        version.schema_version AS "schemaVersion",
        version.content_json AS "contentJson",
        version.content_hash AS "contentHash",
        version.source_run_id AS "sourceRunId",
        version.created_by AS "createdBy",
        version.created_at AS "createdAt"
      FROM content_versions AS version
      JOIN content_packages AS package
        ON package.id = version.package_id AND package.tenant_id = version.tenant_id
      WHERE version.id = ${contentVersionId}::uuid
        AND version.tenant_id = ${scope.tenantId}::uuid
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
    const row = rows[0];
    if (!row) return undefined;
    return { ...row, blocks: await listBlocks(this.client, scope.tenantId, row.id) };
  }

  public async list(
    scope: ContentScope,
    packageId: string,
    variantId: string | null,
  ): Promise<readonly ContentVersionDetail[]> {
    const rows = await this.client<VersionRow[]>`
      SELECT
        version.id,
        version.tenant_id AS "tenantId",
        version.package_id AS "packageId",
        version.variant_id AS "variantId",
        version.version_no AS "versionNo",
        version.schema_version AS "schemaVersion",
        version.content_json AS "contentJson",
        version.content_hash AS "contentHash",
        version.source_run_id AS "sourceRunId",
        version.created_by AS "createdBy",
        version.created_at AS "createdAt"
      FROM content_versions AS version
      JOIN content_packages AS package
        ON package.id = version.package_id AND package.tenant_id = version.tenant_id
      WHERE version.tenant_id = ${scope.tenantId}::uuid
        AND version.package_id = ${packageId}::uuid
        AND version.variant_id IS NOT DISTINCT FROM ${variantId}::uuid
        AND package.workspace_id = ${scope.workspaceId}::uuid
        AND package.project_id = ${scope.projectId}::uuid
        AND package.deleted_at IS NULL
        AND has_project_scope_access(
          package.tenant_id,
          package.workspace_id,
          package.project_id,
          ${scope.userId}::uuid
        )
      ORDER BY version.version_no DESC, version.id
    `;
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        blocks: await listBlocks(this.client, scope.tenantId, row.id),
      })),
    );
  }

  public async create(
    transaction: TransactionSql,
    scope: ContentScope,
    input: CreateContentVersionInput,
    audit: ContentMutationAudit,
  ): Promise<ContentVersionDetail> {
    assertExpectedVersion(input.expectedVersion);
    const blocks = parseDocument(input.contentJson, input.schemaVersion);
    await assertContentProducer(transaction, scope);
    const object = await lockContentObject(transaction, scope, input.packageId, input.variantId);
    if (!object) throw new ContentVersionNotFoundError();
    if (!object.editable) {
      throw new ContentVersionStateError('Cancelled or archived content cannot be versioned');
    }
    if (object.aggregateVersion !== input.expectedVersion) {
      throw new ContentVersionVersionConflictError();
    }
    assertPlatformMatches(input.contentJson, object.platformCode);

    const contentHash = sha256(canonicalJson(input.contentJson));
    const duplicate = await transaction<{ id: string }[]>`
      SELECT id
      FROM content_versions
      WHERE tenant_id = ${scope.tenantId}::uuid
        AND package_id = ${input.packageId}::uuid
        AND variant_id IS NOT DISTINCT FROM ${input.variantId}::uuid
        AND content_hash = ${contentHash}
      LIMIT 1
    `;
    if (duplicate.length > 0) {
      throw new ContentVersionStateError('Identical content already exists in this history');
    }

    const versionNumbers = await transaction<{ versionNo: number }[]>`
      SELECT COALESCE(max(version_no), 0)::integer + 1 AS "versionNo"
      FROM content_versions
      WHERE tenant_id = ${scope.tenantId}::uuid
        AND package_id = ${input.packageId}::uuid
        AND variant_id IS NOT DISTINCT FROM ${input.variantId}::uuid
    `;
    const versionNo = versionNumbers[0]?.versionNo;
    if (!versionNo) throw new Error('Could not allocate the next content version number');

    const inserted = await transaction<VersionRow[]>`
      INSERT INTO content_versions (
        tenant_id,
        package_id,
        variant_id,
        version_no,
        schema_version,
        content_json,
        content_hash,
        source_run_id,
        created_by
      ) VALUES (
        ${scope.tenantId}::uuid,
        ${input.packageId}::uuid,
        ${input.variantId}::uuid,
        ${versionNo},
        ${input.schemaVersion},
        ${JSON.stringify(input.contentJson)}::text::jsonb,
        ${contentHash},
        ${input.sourceRunId ?? null}::uuid,
        ${scope.userId}::uuid
      )
      RETURNING
        id,
        tenant_id AS "tenantId",
        package_id AS "packageId",
        variant_id AS "variantId",
        version_no AS "versionNo",
        schema_version AS "schemaVersion",
        content_json AS "contentJson",
        content_hash AS "contentHash",
        source_run_id AS "sourceRunId",
        created_by AS "createdBy",
        created_at AS "createdAt"
    `;
    const version = inserted[0];
    if (!version) throw new Error('Content Version insert did not return a row');
    const blockRows = await insertBlocks(transaction, scope.tenantId, version.id, blocks);
    await insertDocumentCitations(transaction, scope.tenantId, version.id, input.contentJson);
    await pointToVersion(transaction, scope.tenantId, object, version.id, input.expectedVersion);
    await insertVersionAudit(transaction, {
      action: 'content_version.created',
      actorUserId: scope.userId,
      after: {
        aggregate_version: input.expectedVersion + 1,
        content_hash: version.contentHash,
        content_version_id: version.id,
        version_no: version.versionNo,
      },
      audit,
      resourceId: version.id,
      tenantId: scope.tenantId,
    });
    return { ...version, blocks: blockRows };
  }

  public async diff(
    scope: ContentScope,
    baseVersionId: string,
    targetVersionId: string,
  ): Promise<ContentVersionDiff> {
    const [base, target] = await Promise.all([
      this.find(scope, baseVersionId),
      this.find(scope, targetVersionId),
    ]);
    if (!base || !target) throw new ContentVersionNotFoundError();
    if (base.packageId !== target.packageId || base.variantId !== target.variantId) {
      throw new ContentVersionStateError('Only versions of the same content object can be diffed');
    }

    return {
      base: versionIdentity(base),
      blocks: diffBlocks(
        parseDocument(base.contentJson, base.schemaVersion),
        parseDocument(target.contentJson, target.schemaVersion),
      ),
      fields: diffTopLevelFields(base.contentJson, target.contentJson),
      target: versionIdentity(target),
    };
  }

  public async rollback(
    transaction: TransactionSql,
    scope: ContentScope,
    targetVersionId: string,
    expectedVersion: number,
    audit: ContentMutationAudit,
  ): Promise<ContentVersionDetail> {
    assertExpectedVersion(expectedVersion);
    await assertContentProducer(transaction, scope);
    const target = await findVersionForUpdate(transaction, scope, targetVersionId);
    if (!target) throw new ContentVersionNotFoundError();
    const object = await lockContentObject(transaction, scope, target.packageId, target.variantId);
    if (!object) throw new ContentVersionNotFoundError();
    if (!object.editable) {
      throw new ContentVersionStateError('Cancelled or archived content cannot be rolled back');
    }
    if (object.aggregateVersion !== expectedVersion) {
      throw new ContentVersionVersionConflictError();
    }
    if (object.currentContentVersionId === target.id) {
      throw new ContentVersionStateError('The requested Content Version is already current');
    }

    await pointToVersion(transaction, scope.tenantId, object, target.id, expectedVersion);
    await insertVersionAudit(transaction, {
      action: 'content_version.rolled_back',
      actorUserId: scope.userId,
      after: {
        aggregate_version: expectedVersion + 1,
        content_hash: target.contentHash,
        content_version_id: target.id,
        version_no: target.versionNo,
      },
      audit,
      before: { content_version_id: object.currentContentVersionId },
      resourceId: target.id,
      tenantId: scope.tenantId,
    });
    return {
      ...target,
      blocks: await listBlocks(transaction, scope.tenantId, target.id),
    };
  }
}

function parseDocument(
  content: ContentDocument,
  schemaVersion: string,
): readonly StructuredContentBlock[] {
  if (!schemaVersion.trim() || schemaVersion.length > 32) {
    throw new ContentVersionValidationError(
      'schemaVersion must contain between 1 and 32 characters',
    );
  }
  if (!isRecord(content) || content.schema_version !== schemaVersion) {
    throw new ContentVersionValidationError('contentJson.schema_version must match schemaVersion');
  }
  canonicalJson(content);
  const value = content.blocks;
  if (!Array.isArray(value) || value.length < 1) {
    throw new ContentVersionValidationError('contentJson.blocks must contain at least one block');
  }
  const seen = new Set<string>();
  return value.map((candidate, position) => {
    if (!isRecord(candidate)) {
      throw new ContentVersionValidationError(`Block at position ${position} must be an object`);
    }
    const blockKey = candidate.block_key;
    const blockType = candidate.block_type;
    const text = candidate.text;
    if (typeof blockKey !== 'string' || !BLOCK_KEY.test(blockKey)) {
      throw new ContentVersionValidationError(
        `Block at position ${position} has an invalid block_key`,
      );
    }
    if (seen.has(blockKey)) {
      throw new ContentVersionValidationError(`Duplicate block_key: ${blockKey}`);
    }
    if (typeof blockType !== 'string' || !BLOCK_TYPES.has(blockType as ContentBlockType)) {
      throw new ContentVersionValidationError(`Block ${blockKey} has an invalid block_type`);
    }
    if (typeof text !== 'string') {
      throw new ContentVersionValidationError(`Block ${blockKey} text must be a string`);
    }
    seen.add(blockKey);
    return {
      block_key: blockKey,
      block_type: blockType as ContentBlockType,
      text,
    };
  });
}

function assertPlatformMatches(content: ContentDocument, expected: PlatformCode | 'master'): void {
  if (content.platform_code !== expected) {
    throw new ContentVersionValidationError(
      `contentJson.platform_code must be ${expected} for this content object`,
    );
  }
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
  if (rows.length !== 1) throw new ContentVersionNotFoundError();
}

async function lockContentObject(
  transaction: TransactionSql,
  scope: ContentScope,
  packageId: string,
  variantId: string | null,
): Promise<ContentObjectRow | undefined> {
  if (variantId === null) {
    const rows = await transaction<ContentObjectRow[]>`
      SELECT
        package.id AS "packageId",
        NULL::uuid AS "variantId",
        'master'::text AS "platformCode",
        package.version AS "aggregateVersion",
        package.master_content_version_id AS "currentContentVersionId",
        package.status NOT IN ('cancelled', 'archived') AS editable
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

  const rows = await transaction<ContentObjectRow[]>`
    SELECT
      package.id AS "packageId",
      variant.id AS "variantId",
      variant.platform_code AS "platformCode",
      variant.version AS "aggregateVersion",
      variant.current_content_version_id AS "currentContentVersionId",
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
    WHERE package.id = ${packageId}::uuid
      AND variant.id = ${variantId}::uuid
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
    FOR UPDATE OF package, variant
  `;
  return rows[0];
}

async function findVersionForUpdate(
  transaction: TransactionSql,
  scope: ContentScope,
  contentVersionId: string,
): Promise<VersionRow | undefined> {
  const rows = await transaction<VersionRow[]>`
    SELECT
      version.id,
      version.tenant_id AS "tenantId",
      version.package_id AS "packageId",
      version.variant_id AS "variantId",
      version.version_no AS "versionNo",
      version.schema_version AS "schemaVersion",
      version.content_json AS "contentJson",
      version.content_hash AS "contentHash",
      version.source_run_id AS "sourceRunId",
      version.created_by AS "createdBy",
      version.created_at AS "createdAt"
    FROM content_versions AS version
    JOIN content_packages AS package
      ON package.id = version.package_id AND package.tenant_id = version.tenant_id
    WHERE version.id = ${contentVersionId}::uuid
      AND version.tenant_id = ${scope.tenantId}::uuid
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
    FOR SHARE OF version
  `;
  return rows[0];
}

async function pointToVersion(
  transaction: TransactionSql,
  tenantId: string,
  object: ContentObjectRow,
  contentVersionId: string,
  expectedVersion: number,
): Promise<void> {
  if (object.variantId === null) {
    const rows = await transaction<{ id: string }[]>`
      UPDATE content_packages
      SET master_content_version_id = ${contentVersionId}::uuid, version = version + 1
      WHERE id = ${object.packageId}::uuid
        AND tenant_id = ${tenantId}::uuid
        AND version = ${expectedVersion}
      RETURNING id
    `;
    if (rows.length !== 1) throw new ContentVersionVersionConflictError();
    return;
  }

  const rows = await transaction<{ id: string }[]>`
    UPDATE content_variants
    SET current_content_version_id = ${contentVersionId}::uuid, version = version + 1
    WHERE id = ${object.variantId}::uuid
      AND tenant_id = ${tenantId}::uuid
      AND package_id = ${object.packageId}::uuid
      AND version = ${expectedVersion}
    RETURNING id
  `;
  if (rows.length !== 1) throw new ContentVersionVersionConflictError();
}

async function insertBlocks(
  transaction: TransactionSql,
  tenantId: string,
  contentVersionId: string,
  blocks: readonly StructuredContentBlock[],
): Promise<readonly ContentBlockView[]> {
  const rows: ContentBlockView[] = [];
  for (const [position, block] of blocks.entries()) {
    const inserted = await transaction<ContentBlockView[]>`
      INSERT INTO content_blocks (
        tenant_id, content_version_id, block_key, block_type, position, text_hash
      ) VALUES (
        ${tenantId}::uuid,
        ${contentVersionId}::uuid,
        ${block.block_key},
        ${block.block_type},
        ${position},
        ${sha256(block.text)}
      )
      RETURNING
        id,
        tenant_id AS "tenantId",
        content_version_id AS "contentVersionId",
        block_key AS "blockKey",
        block_type AS "blockType",
        position,
        text_hash AS "textHash",
        created_at AS "createdAt"
    `;
    const row = inserted[0];
    if (!row) throw new Error('Content Block insert did not return a row');
    rows.push(row);
  }
  return rows;
}

async function insertDocumentCitations(
  transaction: TransactionSql,
  tenantId: string,
  contentVersionId: string,
  content: ContentDocument,
): Promise<void> {
  const raw = content.citation_map;
  if (!Array.isArray(raw)) {
    throw new ContentVersionValidationError('contentJson.citation_map must be an array');
  }
  const inserted = new Set<string>();
  for (const value of raw) {
    if (!isRecord(value)) {
      throw new ContentVersionValidationError('contentJson citation mapping is invalid');
    }
    const citationIds = value['citation_ids'];
    const claimKey = value['claim_key'];
    const claimText = value['claim_text'];
    if (
      !Array.isArray(citationIds) ||
      citationIds.length === 0 ||
      citationIds.some((id) => typeof id !== 'string') ||
      new Set(citationIds).size !== citationIds.length ||
      typeof claimKey !== 'string' ||
      claimKey.trim().length < 1 ||
      claimKey.length > 80 ||
      typeof claimText !== 'string' ||
      claimText.trim().length < 1
    ) {
      throw new ContentVersionValidationError('contentJson citation mapping is invalid');
    }
    for (const chunkId of citationIds as readonly string[]) {
      const key = `${claimKey}:${chunkId}`;
      if (inserted.has(key)) continue;
      inserted.add(key);
      const rows = await transaction<{ id: string }[]>`
        INSERT INTO ai_citations (
          tenant_id, content_version_id, claim_key, claim_text,
          chunk_id, quote_text, quote_hash
        )
        SELECT
          ${tenantId}::uuid, ${contentVersionId}::uuid, ${claimKey}, ${claimText},
          chunk.id, chunk.text, encode(digest(chunk.text, 'sha256'), 'hex')
        FROM source_chunks AS chunk
        WHERE chunk.id = ${chunkId}::uuid
          AND chunk.tenant_id = ${tenantId}::uuid
          AND chunk.status = 'active'
        RETURNING id
      `;
      if (rows.length !== 1) {
        throw new ContentVersionValidationError(
          'contentJson citation references an unavailable source chunk',
        );
      }
    }
  }
}

async function listBlocks(
  client: DatabaseClient | TransactionSql,
  tenantId: string,
  contentVersionId: string,
): Promise<readonly ContentBlockView[]> {
  return client<ContentBlockView[]>`
    SELECT
      id,
      tenant_id AS "tenantId",
      content_version_id AS "contentVersionId",
      block_key AS "blockKey",
      block_type AS "blockType",
      position,
      text_hash AS "textHash",
      created_at AS "createdAt"
    FROM content_blocks
    WHERE tenant_id = ${tenantId}::uuid
      AND content_version_id = ${contentVersionId}::uuid
    ORDER BY position, id
  `;
}

interface VersionAuditInput {
  readonly action: 'content_version.created' | 'content_version.rolled_back';
  readonly actorUserId: string;
  readonly after: unknown;
  readonly audit: ContentMutationAudit;
  readonly before?: unknown;
  readonly resourceId: string;
  readonly tenantId: string;
}

async function insertVersionAudit(
  transaction: TransactionSql,
  input: VersionAuditInput,
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
      ${input.tenantId}::uuid,
      ${input.actorUserId}::uuid,
      ${input.action},
      'content_version',
      ${input.resourceId}::uuid,
      ${input.before === undefined ? null : JSON.stringify(input.before)}::text::jsonb,
      ${JSON.stringify(input.after)}::text::jsonb,
      ${input.audit.ip ?? null},
      ${input.audit.requestId}
    )
    RETURNING id
  `;
  if (rows.length !== 1) throw new Error('Required Content Version audit write failed');
}

function diffBlocks(
  base: readonly StructuredContentBlock[],
  target: readonly StructuredContentBlock[],
): readonly ContentBlockDiff[] {
  const baseByKey = new Map(
    base.map((block, position) => [block.block_key, snapshot(block, position)]),
  );
  const targetByKey = new Map(
    target.map((block, position) => [block.block_key, snapshot(block, position)]),
  );
  const keys = [...new Set([...baseByKey.keys(), ...targetByKey.keys()])].sort();
  const changes: ContentBlockDiff[] = [];
  for (const blockKey of keys) {
    const before = baseByKey.get(blockKey);
    const after = targetByKey.get(blockKey);
    if (!before && after) {
      changes.push({ after, blockKey, change: 'added' });
    } else if (before && !after) {
      changes.push({ before, blockKey, change: 'removed' });
    } else if (
      before &&
      after &&
      (before.textHash !== after.textHash || before.blockType !== after.blockType)
    ) {
      changes.push({ after, before, blockKey, change: 'modified' });
    } else if (before && after && before.position !== after.position) {
      changes.push({ after, before, blockKey, change: 'moved' });
    }
  }
  return changes;
}

function diffTopLevelFields(
  base: ContentDocument,
  target: ContentDocument,
): readonly ContentFieldDiff[] {
  const baseRecord = base as Readonly<Record<string, ContentJsonValue>>;
  const targetRecord = target as Readonly<Record<string, ContentJsonValue>>;
  const keys = [...new Set([...Object.keys(baseRecord), ...Object.keys(targetRecord)])]
    .filter((key) => key !== 'blocks')
    .sort();
  const changes: ContentFieldDiff[] = [];
  for (const field of keys) {
    const before = baseRecord[field];
    const after = targetRecord[field];
    if (!Object.hasOwn(baseRecord, field)) {
      changes.push({ after: after!, field });
    } else if (!Object.hasOwn(targetRecord, field)) {
      changes.push({ before: before!, field });
    } else if (canonicalJson(before) !== canonicalJson(after)) {
      changes.push({ after: after!, before: before!, field });
    }
  }
  return changes;
}

function snapshot(block: StructuredContentBlock, position: number): ContentBlockSnapshot {
  return {
    blockKey: block.block_key,
    blockType: block.block_type,
    position,
    text: block.text,
    textHash: sha256(block.text),
  };
}

function versionIdentity(
  version: ContentVersionView,
): Pick<ContentVersionView, 'contentHash' | 'id' | 'versionNo'> {
  return { contentHash: version.contentHash, id: version.id, versionNo: version.versionNo };
}

function canonicalJson(value: unknown, path = '$'): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ContentVersionValidationError(`${path} contains a non-finite number`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalJson(item, `${path}[${index}]`)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], `${path}.${key}`)}`)
      .join(',')}}`;
  }
  throw new ContentVersionValidationError(`${path} contains a value that JSON cannot represent`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertExpectedVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ContentVersionValidationError('expectedVersion must be a positive integer');
  }
}
