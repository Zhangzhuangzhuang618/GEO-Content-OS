import type { AnalyticsExportQuery } from '@geo-content-os/contracts';
import { createHash, randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';

import type { DatabaseClient } from '../../database/index.js';
import type { OutboxWriter } from '../outbox/index.js';
import {
  AnalyticsApiAccessError,
  AnalyticsApiStateError,
  AnalyticsApiValidationError,
} from './analytics-api.errors.js';
import type {
  AnalyticsApiScope,
  AnalyticsExportJobView,
  ImportJobView,
  MetricRecordView,
} from './analytics-api.types.js';

export interface AnalyticsDatabaseProvider {
  readonly client: DatabaseClient;
}

interface AnalyticsExportRow {
  readonly contentHash: string | null;
  readonly createdAt: Date;
  readonly error: Readonly<Record<string, unknown>> | null;
  readonly expiresAt: Date | null;
  readonly id: string;
  readonly objectUri: string | null;
  readonly queryHash: string;
  readonly requestedBy: string;
  readonly rowCount: number | null;
  readonly status: string;
  readonly tenantId: string;
  readonly updatedAt: Date;
  readonly version: number;
  readonly workspaceId: string | null;
}

interface ImportJobRow {
  readonly contentHash: string | null;
  readonly createdAt: Date;
  readonly error: Readonly<Record<string, unknown>> | null;
  readonly id: string;
  readonly rowCount: number | null;
  readonly source: string;
  readonly status: string;
  readonly updatedAt: Date;
  readonly workspaceId: string;
}

export class AnalyticsApiService {
  public constructor(
    private readonly database: DatabaseClient | AnalyticsDatabaseProvider,
    private readonly outbox: OutboxWriter,
  ) {}

  public async requestExport(
    transaction: TransactionSql,
    scope: AnalyticsApiScope,
    query: AnalyticsExportQuery,
  ): Promise<AnalyticsExportJobView> {
    await assertAnalyticsAccess(transaction, scope, query.workspace_id);
    const normalized = normalizeExportQuery(query);
    const queryJson = { ...normalized, schema_version: 'analytics-export-query@1' as const };
    const queryHash = createHash('sha256').update(JSON.stringify(queryJson)).digest('hex');
    const id = randomUUID();
    const rows = await transaction<AnalyticsExportRow[]>`
      INSERT INTO analytics_export_jobs (
        id, tenant_id, workspace_id, requested_by, query_hash, query_json
      ) VALUES (
        ${id}::uuid, ${scope.tenantId}::uuid, ${query.workspace_id}::uuid,
        ${scope.userId}::uuid, ${queryHash}, ${JSON.stringify(queryJson)}::text::jsonb
      )
      ON CONFLICT (tenant_id, query_hash) WHERE status IN ('queued', 'running')
      DO NOTHING
      RETURNING
        id, tenant_id AS "tenantId", workspace_id AS "workspaceId",
        requested_by AS "requestedBy", query_hash AS "queryHash", status,
        object_uri AS "objectUri", content_hash AS "contentHash", row_count AS "rowCount",
        error_json AS error, expires_at AS "expiresAt", version,
        created_at AS "createdAt", updated_at AS "updatedAt"
    `;
    if (rows[0]) {
      await this.outbox.enqueue(
        {
          aggregateId: id,
          aggregateType: 'analytics_export_job',
          data: {
            analytics_export_job_id: id,
            query_hash: queryHash,
            workspace_id: query.workspace_id,
          },
          eventType: 'analytics.export.requested.v1',
          tenantId: scope.tenantId,
        },
        transaction,
      );
      await audit(transaction, scope, 'analytics_export.queued', id, {
        query_hash: queryHash,
        workspace_id: query.workspace_id,
      });
      return exportView(rows[0]);
    }
    const existing = await selectExport(transaction, scope.tenantId, queryHash);
    if (!existing) throw new AnalyticsApiStateError();
    return exportView(existing);
  }

  public async getImport(scope: AnalyticsApiScope, id: string): Promise<ImportJobView> {
    return resolveClient(this.database).begin((transaction) =>
      this.getImportInTransaction(transaction, scope, id),
    );
  }

  public async getImportInTransaction(
    transaction: TransactionSql,
    scope: AnalyticsApiScope,
    id: string,
  ): Promise<ImportJobView> {
    const rows = await transaction<ImportJobRow[]>`
        SELECT
          job.id, job.workspace_id AS "workspaceId", job.source,
          job.content_hash AS "contentHash", job.status, job.row_count AS "rowCount",
          job.error_json AS error, job.created_at AS "createdAt", job.updated_at AS "updatedAt"
        FROM import_jobs AS job
        WHERE job.id = ${id}::uuid
          AND job.tenant_id = ${scope.tenantId}::uuid
          AND EXISTS (
            SELECT 1 FROM memberships AS membership
            WHERE membership.tenant_id = job.tenant_id
              AND membership.user_id = ${scope.userId}::uuid
              AND membership.status = 'active'
              AND membership.role_code IN ('tenant_owner', 'tenant_admin', 'analyst')
          )
          AND has_project_scope_access(
            job.tenant_id, job.workspace_id, NULL, ${scope.userId}::uuid
          )
        LIMIT 1
      `;
    if (!rows[0]) throw new AnalyticsApiStateError();
    return importView(rows[0]);
  }

  public async getMetricRecords(
    transaction: TransactionSql,
    scope: AnalyticsApiScope,
    importJobId: string,
  ): Promise<readonly MetricRecordView[]> {
    const rows = await transaction<MetricRecordView[]>`
      SELECT
        metric.id, metric.tenant_id AS "tenantId", metric.workspace_id AS "workspaceId",
        metric.import_job_id AS "importJobId", metric.platform_code AS "platformCode",
        metric.account_id AS "accountId", metric.variant_id AS "variantId",
        metric.metric_date::text AS "metricDate", metric.metric_name AS "metricName",
        metric.metric_value::float8 AS "metricValue", metric.source,
        metric.created_at AS "createdAt"
      FROM metric_records AS metric
      WHERE metric.tenant_id = ${scope.tenantId}::uuid
        AND metric.import_job_id = ${importJobId}::uuid
        AND has_project_scope_access(
          metric.tenant_id, metric.workspace_id, NULL, ${scope.userId}::uuid
        )
      ORDER BY metric.created_at, metric.id
    `;
    return Object.freeze(rows.map((row) => Object.freeze(row)));
  }
}

function normalizeExportQuery(query: AnalyticsExportQuery) {
  if (query.from > query.to) throw new AnalyticsApiValidationError();
  return Object.freeze({
    format: query.format,
    from: query.from,
    platform_codes: [...(query.platform_codes ?? [])].sort(),
    project_id: query.project_id ?? null,
    to: query.to,
    workspace_id: query.workspace_id,
  });
}

async function assertAnalyticsAccess(
  transaction: TransactionSql,
  scope: AnalyticsApiScope,
  workspaceId: string,
): Promise<void> {
  const rows = await transaction<{ allowed: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM workspaces AS workspace
      JOIN memberships AS membership ON membership.tenant_id = workspace.tenant_id
      JOIN users AS identity_user ON identity_user.id = membership.user_id
      WHERE workspace.id = ${workspaceId}::uuid
        AND workspace.tenant_id = ${scope.tenantId}::uuid
        AND workspace.status = 'active'
        AND workspace.deleted_at IS NULL
        AND membership.user_id = ${scope.userId}::uuid
        AND membership.status = 'active'
        AND membership.role_code IN ('tenant_owner', 'tenant_admin', 'analyst')
        AND identity_user.status = 'active'
        AND identity_user.deleted_at IS NULL
        AND has_project_scope_access(
          workspace.tenant_id, workspace.id, NULL, membership.user_id
        )
    ) AS allowed
  `;
  if (rows[0]?.allowed !== true) throw new AnalyticsApiAccessError();
}

async function selectExport(
  transaction: TransactionSql,
  tenantId: string,
  queryHash: string,
): Promise<AnalyticsExportRow | undefined> {
  const rows = await transaction<AnalyticsExportRow[]>`
    SELECT
      id, tenant_id AS "tenantId", workspace_id AS "workspaceId",
      requested_by AS "requestedBy", query_hash AS "queryHash", status,
      object_uri AS "objectUri", content_hash AS "contentHash", row_count AS "rowCount",
      error_json AS error, expires_at AS "expiresAt", version,
      created_at AS "createdAt", updated_at AS "updatedAt"
    FROM analytics_export_jobs
    WHERE tenant_id = ${tenantId}::uuid AND query_hash = ${queryHash}
      AND status IN ('queued', 'running')
    LIMIT 1
  `;
  return rows[0];
}

async function audit(
  transaction: TransactionSql,
  scope: AnalyticsApiScope,
  action: string,
  resourceId: string,
  after: unknown,
): Promise<void> {
  await transaction`
    INSERT INTO audit_events (
      tenant_id, actor_id, action, resource_type, resource_id, after_json, request_id
    ) VALUES (
      ${scope.tenantId}::uuid, ${scope.userId}::uuid, ${action},
      'analytics_export_job', ${resourceId}::uuid,
      ${JSON.stringify(after)}::text::jsonb, ${scope.requestId}
    )
  `;
}

function exportView(row: AnalyticsExportRow): AnalyticsExportJobView {
  if (!['expired', 'failed', 'queued', 'running', 'succeeded'].includes(row.status)) {
    throw new AnalyticsApiStateError();
  }
  return Object.freeze({ ...row, status: row.status as AnalyticsExportJobView['status'] });
}

function importView(row: ImportJobRow): ImportJobView {
  if (!['api', 'csv', 'manual'].includes(row.source)) throw new AnalyticsApiStateError();
  if (!['failed', 'queued', 'rolled_back', 'running', 'succeeded'].includes(row.status)) {
    throw new AnalyticsApiStateError();
  }
  return Object.freeze({
    ...row,
    source: row.source as ImportJobView['source'],
    status: row.status as ImportJobView['status'],
  });
}

function resolveClient(database: DatabaseClient | AnalyticsDatabaseProvider): DatabaseClient {
  return typeof database === 'function' ? database : database.client;
}
