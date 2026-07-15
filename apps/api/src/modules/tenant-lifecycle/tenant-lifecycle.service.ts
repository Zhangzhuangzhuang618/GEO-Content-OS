import { UuidSchema } from '@geo-content-os/contracts';
import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';

import type { DatabaseClient } from '../../database/index.js';
import { RequiredAuditWriter } from '../audit/index.js';
import type { OutboxWriter } from '../outbox/index.js';
import {
  TenantLifecycleAccessError,
  TenantLifecycleStateError,
  TenantLifecycleValidationError,
} from './tenant-lifecycle.errors.js';
import type {
  TenantDeletionPlan,
  TenantExportJobView,
  TenantLifecycleScope,
} from './tenant-lifecycle.types.js';

interface TableNameRow {
  readonly tableName: string;
}

interface CountRow {
  readonly count: string;
}

interface ObjectUriRow {
  readonly uri: string;
}

interface TenantLifecycleDatabaseProvider {
  readonly client: DatabaseClient;
}

const EXPORT_RETENTION_DAYS = 7;

export class TenantLifecycleService {
  public constructor(
    private readonly database: DatabaseClient | TenantLifecycleDatabaseProvider,
    private readonly outbox: OutboxWriter,
    private readonly audit = new RequiredAuditWriter(),
  ) {}

  public async requestExport(
    transaction: TransactionSql,
    scope: TenantLifecycleScope,
  ): Promise<TenantExportJobView> {
    const normalized = normalizeScope(scope);
    await assertOwner(transaction, normalized);
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + EXPORT_RETENTION_DAYS * 86_400_000);
    const rows = await transaction<TenantExportJobView[]>`
      INSERT INTO tenant_export_jobs (id, tenant_id, requested_by, status)
      VALUES (${id}::uuid, ${normalized.tenantId}::uuid, ${normalized.userId}::uuid, 'queued')
      RETURNING
        id, tenant_id AS "tenantId", requested_by AS "requestedBy", status,
        object_uri AS "objectUri", manifest_hash AS "manifestHash",
        expires_at AS "expiresAt", error_json AS error,
        created_at AS "createdAt", updated_at AS "updatedAt"
    `;
    const job = rows[0];
    if (!job) throw new TenantLifecycleStateError();
    await this.outbox.enqueue(
      {
        aggregateId: id,
        aggregateType: 'tenant_export_job',
        data: {
          expires_at: expiresAt.toISOString(),
          tenant_export_job_id: id,
        },
        eventType: 'lifecycle.tenant.export_requested.v1',
        tenantId: normalized.tenantId,
      },
      transaction,
    );
    await this.audit.record(transaction, {
      action: 'tenant_export.requested',
      actorId: normalized.userId,
      after: { expires_at: expiresAt.toISOString(), status: 'queued' },
      requestId: normalized.requestId,
      resourceId: id,
      resourceType: 'tenant_export_job',
      tenantId: normalized.tenantId,
    });
    return Object.freeze(job);
  }

  public async getExport(
    scope: TenantLifecycleScope,
    exportJobId: string,
  ): Promise<TenantExportJobView> {
    const normalized = normalizeScope(scope);
    const id = normalizeUuid(exportJobId);
    return resolveClient(this.database).begin(async (transaction) => {
      await assertOwner(transaction, normalized);
      const rows = await transaction<TenantExportJobView[]>`
        SELECT
          id, tenant_id AS "tenantId", requested_by AS "requestedBy", status,
          object_uri AS "objectUri", manifest_hash AS "manifestHash",
          expires_at AS "expiresAt", error_json AS error,
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM tenant_export_jobs
        WHERE id = ${id}::uuid AND tenant_id = ${normalized.tenantId}::uuid
        LIMIT 1
      `;
      if (!rows[0]) throw new TenantLifecycleStateError();
      return Object.freeze(rows[0]);
    });
  }

  public async dryRunDeletion(scope: TenantLifecycleScope): Promise<TenantDeletionPlan> {
    const normalized = normalizeScope(scope);
    return resolveClient(this.database).begin(async (transaction) => {
      await assertOwner(transaction, normalized);
      const tableRows = await transaction<TableNameRow[]>`
        SELECT DISTINCT table_name AS "tableName"
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'tenant_id'
          AND table_name !~ '^__'
        ORDER BY table_name
      `;
      const rowCounts: Record<string, number> = {};
      for (const row of tableRows) {
        const quoted = quoteIdentifier(row.tableName);
        const counts = await transaction.unsafe<CountRow[]>(
          `SELECT count(*)::text AS count FROM ${quoted} WHERE tenant_id = $1::uuid`,
          [normalized.tenantId],
        );
        rowCounts[row.tableName] = safeCount(counts[0]?.count);
      }
      const objects = await transaction<ObjectUriRow[]>`
        SELECT uri FROM (
          SELECT source.uri
          FROM source_documents AS source
          WHERE source.tenant_id = ${normalized.tenantId}::uuid
            AND source.source_type <> 'url'
            AND source.uri IS NOT NULL
          UNION
          SELECT asset.object_uri AS uri
          FROM media_assets AS asset
          WHERE asset.tenant_id = ${normalized.tenantId}::uuid
          UNION
          SELECT artifact.object_uri AS uri
          FROM export_artifacts AS artifact
          WHERE artifact.tenant_id = ${normalized.tenantId}::uuid
          UNION
          SELECT export.object_uri AS uri
          FROM tenant_export_jobs AS export
          WHERE export.tenant_id = ${normalized.tenantId}::uuid
            AND export.object_uri IS NOT NULL
        ) AS tenant_objects
        ORDER BY uri
      `;
      const frozenCounts = Object.freeze({ ...rowCounts });
      return Object.freeze({
        objectUris: Object.freeze(objects.map((row) => row.uri)),
        rowCounts: frozenCounts,
        tenantId: normalized.tenantId,
        totalRows: Object.values(frozenCounts).reduce((sum, count) => sum + count, 0),
      });
    });
  }

  public async archiveForDeletion(
    transaction: TransactionSql,
    scope: TenantLifecycleScope,
    exportJobId: string,
    confirmationSlug: string,
  ): Promise<void> {
    const normalized = normalizeScope(scope);
    const id = normalizeUuid(exportJobId);
    await assertOwner(transaction, normalized);
    const rows = await transaction<{ slug: string }[]>`
      SELECT tenant.slug
      FROM tenants AS tenant
      JOIN tenant_export_jobs AS export
        ON export.tenant_id = tenant.id
      WHERE tenant.id = ${normalized.tenantId}::uuid
        AND export.id = ${id}::uuid
        AND export.status = 'succeeded'
        AND export.expires_at > now()
      FOR UPDATE OF tenant
    `;
    const tenant = rows[0];
    if (!tenant || confirmationSlug.trim() !== tenant.slug) {
      throw new TenantLifecycleValidationError();
    }
    await transaction`
      UPDATE tenants
      SET status = 'archived', deleted_at = now()
      WHERE id = ${normalized.tenantId}::uuid AND status <> 'archived'
    `;
    await this.audit.record(transaction, {
      action: 'tenant.deletion_archived',
      actorId: normalized.userId,
      after: { export_job_id: id, status: 'archived' },
      requestId: normalized.requestId,
      resourceId: normalized.tenantId,
      resourceType: 'tenant',
      tenantId: normalized.tenantId,
    });
  }
}

function resolveClient(database: DatabaseClient | TenantLifecycleDatabaseProvider): DatabaseClient {
  return typeof database === 'function' ? database : database.client;
}

async function assertOwner(
  transaction: TransactionSql,
  scope: TenantLifecycleScope,
): Promise<void> {
  const rows = await transaction<{ allowed: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM memberships AS membership
      JOIN users AS identity_user ON identity_user.id = membership.user_id
      JOIN tenants AS tenant ON tenant.id = membership.tenant_id
      WHERE membership.tenant_id = ${scope.tenantId}::uuid
        AND membership.user_id = ${scope.userId}::uuid
        AND membership.role_code = 'tenant_owner'
        AND membership.status = 'active'
        AND identity_user.status = 'active'
        AND identity_user.deleted_at IS NULL
        AND tenant.status = 'active'
        AND tenant.deleted_at IS NULL
    ) AS allowed
  `;
  if (rows[0]?.allowed !== true) throw new TenantLifecycleAccessError();
}

function normalizeScope(scope: TenantLifecycleScope): TenantLifecycleScope {
  const requestId = scope.requestId.trim();
  if (!/^[A-Za-z0-9._:-]{8,80}$/u.test(requestId)) throw new TenantLifecycleValidationError();
  return Object.freeze({
    requestId,
    tenantId: normalizeUuid(scope.tenantId),
    userId: normalizeUuid(scope.userId),
  });
}

function normalizeUuid(value: string): string {
  const parsed = UuidSchema.safeParse(value);
  if (!parsed.success) throw new TenantLifecycleValidationError();
  return parsed.data;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new TenantLifecycleStateError();
  return `"${value}"`;
}

function safeCount(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TenantLifecycleStateError();
  return parsed;
}
