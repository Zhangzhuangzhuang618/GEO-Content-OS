import { createHash, randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';

import type { OutboxWriter } from '../../outbox/index.js';
import type { MetricRegistry } from '../repositories/index.js';

const PLATFORM_CODES = new Set([
  'official_site',
  'baijiahao',
  'sohu',
  'lieju',
  'toutiao',
  'zhihu',
  'xiaohongshu',
  'wechat_mp',
  'douyin',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[0-9a-f]{64}$/u;

export interface MetricsImportScope {
  readonly requestId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

export interface MetricsImportRowInput {
  readonly accountId?: string | null;
  readonly metricDate: string;
  readonly metricName: string;
  readonly metricValue: number;
  readonly platformCode: string;
  readonly variantId?: string | null;
}

export interface MetricsImportRowError {
  readonly index: number;
  readonly message: string;
}

export interface MetricsImportResult {
  readonly duplicateCount: number;
  readonly errors: readonly MetricsImportRowError[];
  readonly importJobId: string;
  readonly insertedCount: number;
  readonly status: 'failed' | 'succeeded';
}

export interface CreatedMetricsImportJob {
  readonly contentHash: string;
  readonly id: string;
  readonly status: 'failed' | 'queued' | 'rolled_back' | 'running' | 'succeeded';
}

export class MetricsImportService {
  public constructor(
    private readonly outboxWriter: OutboxWriter,
    private readonly registry: MetricRegistry,
  ) {}

  public async queueCsv(
    transaction: TransactionSql,
    scope: MetricsImportScope,
    input: { readonly contentHash: string; readonly objectKey: string; readonly objectUri: string },
  ): Promise<CreatedMetricsImportJob> {
    if (
      !HASH.test(input.contentHash) ||
      !safeObjectKey(input.objectKey) ||
      !input.objectUri.trim()
    ) {
      throw new MetricsImportValidationError();
    }
    await assertImportAccess(transaction, scope);
    const id = randomUUID();
    const inserted = await transaction<{ id: string }[]>`
      INSERT INTO import_jobs (
        id, tenant_id, workspace_id, source, file_uri, content_hash, status, created_by
      ) VALUES (
        ${id}::uuid, ${scope.tenantId}::uuid, ${scope.workspaceId}::uuid,
        'csv', ${input.objectUri}, ${input.contentHash}, 'queued', ${scope.userId}::uuid
      )
      ON CONFLICT (tenant_id, workspace_id, content_hash)
        WHERE content_hash IS NOT NULL
      DO NOTHING
      RETURNING id
    `;
    if (inserted.length === 0) {
      const existing = await transaction<{ id: string; status: string }[]>`
        SELECT id, status
        FROM import_jobs
        WHERE tenant_id = ${scope.tenantId}::uuid
          AND workspace_id = ${scope.workspaceId}::uuid
          AND content_hash = ${input.contentHash}
        LIMIT 1
      `;
      if (!existing[0]) throw new MetricsImportStateError();
      return Object.freeze({
        contentHash: input.contentHash,
        id: existing[0].id,
        status: importJobStatus(existing[0].status),
      });
    }
    await this.outboxWriter.enqueue(
      {
        aggregateId: id,
        aggregateType: 'import_job',
        data: {
          content_hash: input.contentHash,
          import_job_id: id,
          object_key: input.objectKey,
          workspace_id: scope.workspaceId,
        },
        eventType: 'analytics.metrics.import_requested.v1',
        tenantId: scope.tenantId,
      },
      transaction,
    );
    await audit(transaction, scope, 'metrics_import.queued', id, null, {
      content_hash: input.contentHash,
      source: 'csv',
    });
    return Object.freeze({ contentHash: input.contentHash, id, status: 'queued' });
  }

  public async importRows(
    transaction: TransactionSql,
    scope: MetricsImportScope,
    source: 'api' | 'csv' | 'manual',
    rows: readonly MetricsImportRowInput[],
    importJobId?: string,
  ): Promise<MetricsImportResult> {
    if (rows.length === 0) throw new MetricsImportValidationError();
    await assertImportAccess(transaction, scope);
    const jobId = importJobId ?? (await createInlineJob(transaction, scope, source, rows));
    const jobs = await transaction<{ source: string; status: string }[]>`
      SELECT source, status
      FROM import_jobs
      WHERE id = ${jobId}::uuid
        AND tenant_id = ${scope.tenantId}::uuid
        AND workspace_id = ${scope.workspaceId}::uuid
      FOR UPDATE
    `;
    const job = jobs[0];
    if (!job || job.source !== source || !['queued', 'running'].includes(job.status)) {
      throw new MetricsImportStateError();
    }
    await transaction`
      UPDATE import_jobs SET status = 'running'
      WHERE id = ${jobId}::uuid AND tenant_id = ${scope.tenantId}::uuid
    `;

    let insertedCount = 0;
    let duplicateCount = 0;
    const errors: MetricsImportRowError[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      try {
        const row = normalizeRow(rows[index]!, this.registry);
        const dimensionHash = hashDimension(scope, row);
        const inserted = await transaction<{ id: string }[]>`
          INSERT INTO metric_records (
            tenant_id, workspace_id, import_job_id, platform_code, account_id, variant_id,
            metric_date, metric_name, metric_value, source, dimension_hash
          ) VALUES (
            ${scope.tenantId}::uuid, ${scope.workspaceId}::uuid, ${jobId}::uuid,
            ${row.platformCode}, ${row.accountId}::uuid, ${row.variantId}::uuid,
            ${row.metricDate}::date, ${row.metricName}, ${row.metricValue}, ${source}, ${dimensionHash}
          )
          ON CONFLICT (tenant_id, dimension_hash) DO NOTHING
          RETURNING id
        `;
        if (inserted.length > 0) insertedCount += 1;
        else {
          const same = await transaction<{ same: boolean }[]>`
            SELECT (
              workspace_id = ${scope.workspaceId}::uuid
              AND platform_code = ${row.platformCode}
              AND account_id IS NOT DISTINCT FROM ${row.accountId}::uuid
              AND variant_id IS NOT DISTINCT FROM ${row.variantId}::uuid
              AND metric_date = ${row.metricDate}::date
              AND metric_name = ${row.metricName}
              AND metric_value = ${row.metricValue}
            ) AS same
            FROM metric_records
            WHERE tenant_id = ${scope.tenantId}::uuid AND dimension_hash = ${dimensionHash}
          `;
          if (!same[0]?.same) throw new MetricsImportDimensionConflictError();
          duplicateCount += 1;
        }
      } catch (error) {
        if (!isRecoverableRowError(error)) throw error;
        errors.push({
          index,
          message:
            error instanceof MetricsImportDimensionConflictError
              ? 'Dimension already exists with a different value'
              : 'Metric row is invalid',
        });
      }
    }
    const status = insertedCount + duplicateCount > 0 ? 'succeeded' : 'failed';
    const errorJson = errors.length ? { rows: errors, schema_version: 'import-error@1' } : null;
    await transaction`
      UPDATE import_jobs
      SET
        status = ${status},
        row_count = ${insertedCount + duplicateCount},
        error_json = ${errorJson ? JSON.stringify(errorJson) : null}::text::jsonb
      WHERE id = ${jobId}::uuid AND tenant_id = ${scope.tenantId}::uuid
    `;
    await audit(transaction, scope, 'metrics_import.completed', jobId, null, {
      duplicate_count: duplicateCount,
      error_count: errors.length,
      inserted_count: insertedCount,
      status,
    });
    return Object.freeze({
      duplicateCount,
      errors: Object.freeze(errors),
      importJobId: jobId,
      insertedCount,
      status,
    });
  }

  public async rollback(
    transaction: TransactionSql,
    scope: MetricsImportScope,
    importJobId: string,
    reason: string,
  ): Promise<void> {
    const normalizedReason = reason.trim();
    if (!normalizedReason || normalizedReason.length > 1_000) {
      throw new MetricsImportValidationError();
    }
    await assertImportAccess(transaction, scope);
    const rows = await transaction<{ status: string }[]>`
      UPDATE import_jobs
      SET status = 'rolled_back'
      WHERE id = ${importJobId}::uuid
        AND tenant_id = ${scope.tenantId}::uuid
        AND workspace_id = ${scope.workspaceId}::uuid
        AND status = 'succeeded'
      RETURNING status
    `;
    if (rows.length !== 1) throw new MetricsImportStateError();
    await audit(transaction, scope, 'metrics_import.rolled_back', importJobId, null, {
      reason: normalizedReason,
      status: 'rolled_back',
    });
  }
}

export class MetricsImportValidationError extends Error {}
export class MetricsImportStateError extends Error {}
export class MetricsImportDimensionConflictError extends Error {}

interface NormalizedRow {
  readonly accountId: string | null;
  readonly metricDate: string;
  readonly metricName: string;
  readonly metricValue: number;
  readonly platformCode: string;
  readonly variantId: string | null;
}

function normalizeRow(row: MetricsImportRowInput, registry: MetricRegistry): NormalizedRow {
  const accountId = row.accountId?.trim() || null;
  const variantId = row.variantId?.trim() || null;
  if (
    !PLATFORM_CODES.has(row.platformCode) ||
    !validDate(row.metricDate) ||
    (accountId !== null && !UUID.test(accountId)) ||
    (variantId !== null && !UUID.test(variantId))
  ) {
    throw new MetricsImportValidationError();
  }
  registry.validateValue(row.metricName, row.metricValue);
  return Object.freeze({
    accountId,
    metricDate: row.metricDate,
    metricName: row.metricName,
    metricValue: row.metricValue,
    platformCode: row.platformCode,
    variantId,
  });
}

function hashDimension(scope: MetricsImportScope, row: NormalizedRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        scope.tenantId,
        scope.workspaceId,
        row.platformCode,
        row.accountId,
        row.variantId,
        row.metricDate,
        row.metricName,
      ]),
    )
    .digest('hex');
}

async function createInlineJob(
  transaction: TransactionSql,
  scope: MetricsImportScope,
  source: 'api' | 'csv' | 'manual',
  rows: readonly MetricsImportRowInput[],
): Promise<string> {
  const id = randomUUID();
  const contentHash = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  await transaction`
    INSERT INTO import_jobs (
      id, tenant_id, workspace_id, source, content_hash, status, created_by
    ) VALUES (
      ${id}::uuid, ${scope.tenantId}::uuid, ${scope.workspaceId}::uuid,
      ${source}, ${contentHash}, 'queued', ${scope.userId}::uuid
    )
  `;
  return id;
}

async function assertImportAccess(
  transaction: TransactionSql,
  scope: MetricsImportScope,
): Promise<void> {
  const rows = await transaction<{ allowed: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM workspaces AS workspace
      JOIN memberships AS membership ON membership.tenant_id = workspace.tenant_id
      WHERE workspace.id = ${scope.workspaceId}::uuid
        AND workspace.tenant_id = ${scope.tenantId}::uuid
        AND workspace.status = 'active'
        AND workspace.deleted_at IS NULL
        AND membership.user_id = ${scope.userId}::uuid
        AND membership.status = 'active'
        AND membership.role_code IN ('tenant_owner', 'tenant_admin', 'analyst')
        AND has_project_scope_access(
          workspace.tenant_id, workspace.id, NULL, membership.user_id
        )
    ) AS allowed
  `;
  if (!rows[0]?.allowed) throw new MetricsImportStateError();
}

async function audit(
  transaction: TransactionSql,
  scope: MetricsImportScope,
  action: string,
  resourceId: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await transaction`
    INSERT INTO audit_events (
      tenant_id, actor_id, action, resource_type, resource_id,
      before_json, after_json, request_id
    ) VALUES (
      ${scope.tenantId}::uuid, ${scope.userId}::uuid, ${action}, 'import_job',
      ${resourceId}::uuid, ${before ? JSON.stringify(before) : null}::text::jsonb,
      ${after ? JSON.stringify(after) : null}::text::jsonb, ${scope.requestId}
    )
  `;
}

function safeObjectKey(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1_024 &&
    !value.startsWith('/') &&
    !value.includes('..') &&
    /^[A-Za-z0-9][A-Za-z0-9/_=.-]*$/u.test(value)
  );
}

function importJobStatus(value: string): CreatedMetricsImportJob['status'] {
  if (['failed', 'queued', 'rolled_back', 'running', 'succeeded'].includes(value)) {
    return value as CreatedMetricsImportJob['status'];
  }
  throw new MetricsImportStateError();
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isRecoverableRowError(error: unknown): boolean {
  if (
    error instanceof MetricsImportValidationError ||
    error instanceof MetricsImportDimensionConflictError ||
    error instanceof RangeError ||
    error instanceof TypeError
  ) {
    return true;
  }
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === '23503' || code === '23514' || code === 'P0001';
}
