import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';

import { IdentityAuthDatabase } from '../../../identity/auth/auth.database.js';
import {
  FactAdjudicationNotFoundError,
  FactAdjudicationStateError,
  FactAdjudicationVersionConflictError,
} from './fact-adjudication.errors.js';
import type {
  AdjudicatedFactView,
  FactAdjudicationAuditContext,
  FactAdjudicationDecision,
  VerifyFactRequest,
} from './fact-adjudication.types.js';

interface FactRow {
  readonly confidence: string;
  readonly createdAt: Date | string;
  readonly id: string;
  readonly objectValue: string;
  readonly predicate: string;
  readonly status: AdjudicatedFactView['status'];
  readonly subject: string;
  readonly tenantId: string;
  readonly unit: string | null;
  readonly updatedAt: Date | string;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly workspaceId: string;
}

interface EvidenceRow {
  readonly chunkStatus: 'active' | 'inactive';
  readonly chunkText: string;
  readonly chunkTextHash: string;
  readonly quoteHash: string;
  readonly quoteText: string;
  readonly sourceDeletedAt: Date | string | null;
  readonly sourceStatus: 'active' | 'expired' | 'failed' | 'processing';
  readonly trustLevel: 'normal' | 'untrusted' | 'verified';
}

@Injectable()
export class FactAdjudicationService {
  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
  ) {}

  public async adjudicate(
    tenantId: string,
    actorUserId: string,
    factId: string,
    request: VerifyFactRequest,
    audit: FactAdjudicationAuditContext,
  ): Promise<AdjudicatedFactView> {
    return this.database.client.begin(async (transaction) => {
      await assertFactReviewer(transaction, tenantId, actorUserId);
      const current = await lockFact(transaction, tenantId, actorUserId, factId);
      if (toIso(current.updatedAt) !== request.expected_updated_at) {
        throw new FactAdjudicationVersionConflictError();
      }
      await assertTransition(transaction, current, request.decision);
      if (request.decision === 'verified') {
        await assertVerifiableEvidence(transaction, current);
      }

      const updated = await updateFactStatus(transaction, current, request.decision);
      const before = toFactView(current);
      const after = toFactView(updated);
      await insertFactAudit(transaction, {
        action: `knowledge.fact.${request.decision}`,
        actorUserId,
        after: { ...after, reason: request.reason },
        audit,
        before,
        resourceId: factId,
        tenantId,
      });
      return after;
    });
  }
}

async function assertFactReviewer(
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
      membership.tenant_id = ${tenantId}::uuid
      AND membership.user_id = ${actorUserId}::uuid
      AND membership.status = 'active'
      AND membership.role_code IN ('tenant_owner', 'tenant_admin', 'reviewer')
      AND identity_user.status = 'active'
      AND identity_user.deleted_at IS NULL
      AND tenant.status = 'active'
      AND tenant.deleted_at IS NULL
    LIMIT 1
    FOR SHARE OF membership, identity_user, tenant
  `;
  if (rows.length !== 1) throw new FactAdjudicationNotFoundError();
}

async function lockFact(
  transaction: TransactionSql,
  tenantId: string,
  actorUserId: string,
  factId: string,
): Promise<FactRow> {
  const metadataRows = await transaction<
    { predicate: string; subject: string; workspaceId: string }[]
  >`
    SELECT
      fact.workspace_id AS "workspaceId",
      fact.subject,
      fact.predicate
    FROM facts AS fact
    JOIN workspaces AS workspace
      ON workspace.id = fact.workspace_id AND workspace.tenant_id = fact.tenant_id
    WHERE
      fact.id = ${factId}::uuid
      AND fact.tenant_id = ${tenantId}::uuid
      AND workspace.status = 'active'
      AND workspace.deleted_at IS NULL
      AND has_workspace_scope_access(fact.tenant_id, fact.workspace_id, ${actorUserId}::uuid)
    LIMIT 1
    FOR SHARE OF workspace
  `;
  const metadata = metadataRows[0];
  if (!metadata) throw new FactAdjudicationNotFoundError();

  // Every adjudication of a competing value locks the full fact group in the same order. This
  // prevents two reviewers from deadlocking when they target different values concurrently.
  const group = await transaction<FactRow[]>`
    SELECT
      id,
      tenant_id AS "tenantId",
      workspace_id AS "workspaceId",
      subject,
      predicate,
      object_value AS "objectValue",
      unit,
      valid_from::text AS "validFrom",
      valid_to::text AS "validTo",
      confidence::text AS confidence,
      status,
      to_char(
        created_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS "createdAt",
      to_char(
        updated_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS "updatedAt"
    FROM facts
    WHERE
      tenant_id = ${tenantId}::uuid
      AND workspace_id = ${metadata.workspaceId}::uuid
      AND subject = ${metadata.subject}
      AND predicate = ${metadata.predicate}
    ORDER BY id
    FOR UPDATE
  `;
  const target = group.find((fact) => fact.id === factId);
  if (!target) throw new FactAdjudicationNotFoundError();
  return target;
}

async function assertTransition(
  transaction: TransactionSql,
  fact: FactRow,
  decision: FactAdjudicationDecision,
): Promise<void> {
  if (fact.status === 'retired' || fact.status === decision) {
    throw new FactAdjudicationStateError();
  }
  if (decision === 'conflicted') {
    const competing = await transaction<{ id: string }[]>`
      SELECT id
      FROM facts
      WHERE
        tenant_id = ${fact.tenantId}::uuid
        AND workspace_id = ${fact.workspaceId}::uuid
        AND id <> ${fact.id}::uuid
        AND subject = ${fact.subject}
        AND predicate = ${fact.predicate}
        AND object_value <> ${fact.objectValue}
      AND status <> 'retired'
      ORDER BY id
      LIMIT 1
    `;
    if (competing.length === 0) {
      throw new FactAdjudicationStateError(
        'A conflicted fact requires another active value for the same subject and predicate',
      );
    }
  }
  if (decision === 'verified') {
    const verifiedConflict = await transaction<{ id: string }[]>`
      SELECT id
      FROM facts
      WHERE
        tenant_id = ${fact.tenantId}::uuid
        AND workspace_id = ${fact.workspaceId}::uuid
        AND id <> ${fact.id}::uuid
        AND subject = ${fact.subject}
        AND predicate = ${fact.predicate}
        AND object_value <> ${fact.objectValue}
      AND status = 'verified'
      ORDER BY id
      LIMIT 1
    `;
    if (verifiedConflict.length > 0) {
      throw new FactAdjudicationStateError(
        'A competing verified value must be conflicted or retired before verification',
      );
    }
  }
}

async function assertVerifiableEvidence(transaction: TransactionSql, fact: FactRow): Promise<void> {
  const evidence = await transaction<EvidenceRow[]>`
    SELECT
      evidence.quote_text AS "quoteText",
      evidence.quote_hash AS "quoteHash",
      chunk.text AS "chunkText",
      chunk.text_hash AS "chunkTextHash",
      chunk.status AS "chunkStatus",
      source.status AS "sourceStatus",
      source.trust_level AS "trustLevel",
      source.deleted_at AS "sourceDeletedAt"
    FROM fact_sources AS evidence
    JOIN source_chunks AS chunk
      ON chunk.id = evidence.chunk_id AND chunk.tenant_id = evidence.tenant_id
    JOIN source_documents AS source
      ON source.id = chunk.source_document_id AND source.tenant_id = chunk.tenant_id
    WHERE evidence.tenant_id = ${fact.tenantId}::uuid AND evidence.fact_id = ${fact.id}::uuid
    ORDER BY evidence.id
    FOR SHARE OF evidence, chunk, source
  `;
  for (const item of evidence) {
    if (
      sha256(item.chunkText) !== item.chunkTextHash ||
      sha256(item.quoteText) !== item.quoteHash ||
      !item.chunkText.includes(item.quoteText)
    ) {
      throw new FactAdjudicationStateError('Fact evidence provenance integrity check failed');
    }
  }
  const hasEligibleEvidence = evidence.some(
    (item) =>
      item.sourceDeletedAt === null &&
      item.sourceStatus === 'active' &&
      item.chunkStatus === 'active' &&
      item.trustLevel !== 'untrusted',
  );
  if (!hasEligibleEvidence) {
    throw new FactAdjudicationStateError(
      'Verification requires active evidence from a verified or normal-trust source',
    );
  }
}

async function updateFactStatus(
  transaction: TransactionSql,
  fact: FactRow,
  decision: FactAdjudicationDecision,
): Promise<FactRow> {
  const rows = await transaction<FactRow[]>`
    UPDATE facts
    SET status = ${decision}
    WHERE
      id = ${fact.id}::uuid
      AND tenant_id = ${fact.tenantId}::uuid
      AND updated_at = ${toIso(fact.updatedAt)}::timestamptz
      AND status = ${fact.status}
    RETURNING
      id,
      tenant_id AS "tenantId",
      workspace_id AS "workspaceId",
      subject,
      predicate,
      object_value AS "objectValue",
      unit,
      valid_from::text AS "validFrom",
      valid_to::text AS "validTo",
      confidence::text AS confidence,
      status,
      to_char(
        created_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS "createdAt",
      to_char(
        updated_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS "updatedAt"
  `;
  const row = rows[0];
  if (!row) throw new FactAdjudicationVersionConflictError();
  return row;
}

interface FactAuditInput {
  readonly action: string;
  readonly actorUserId: string;
  readonly after: unknown;
  readonly audit: FactAdjudicationAuditContext;
  readonly before: unknown;
  readonly resourceId: string;
  readonly tenantId: string;
}

async function insertFactAudit(transaction: TransactionSql, input: FactAuditInput): Promise<void> {
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
      'fact',
      ${input.resourceId}::uuid,
      ${JSON.stringify(input.before)}::text::jsonb,
      ${JSON.stringify(input.after)}::text::jsonb,
      ${input.audit.ip ?? null}::inet,
      ${input.audit.requestId}
    )
    RETURNING id
  `;
  if (rows.length !== 1) throw new Error('Required fact adjudication audit write failed');
}

function toFactView(row: FactRow): AdjudicatedFactView {
  return Object.freeze({
    confidence: Number(row.confidence),
    created_at: toIso(row.createdAt),
    id: row.id,
    object_value: row.objectValue,
    predicate: row.predicate,
    status: row.status,
    subject: row.subject,
    tenant_id: row.tenantId,
    unit: row.unit,
    updated_at: toIso(row.updatedAt),
    valid_from: row.validFrom,
    valid_to: row.validTo,
    workspace_id: row.workspaceId,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
