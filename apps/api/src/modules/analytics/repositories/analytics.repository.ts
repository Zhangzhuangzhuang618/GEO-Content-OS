import type { PlatformCode } from '@geo-content-os/contracts';

import type { DatabaseClient } from '../../../database/index.js';

export interface AnalyticsScope {
  readonly tenantId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

export interface AnalyticsDateRange {
  readonly from: string;
  readonly to: string;
}

export interface ImportJobView {
  readonly contentHash: string | null;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly error: Readonly<Record<string, unknown>> | null;
  readonly fileUri: string | null;
  readonly id: string;
  readonly rowCount: number | null;
  readonly source: 'api' | 'csv' | 'manual';
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'rolled_back';
  readonly tenantId: string;
  readonly updatedAt: Date;
  readonly workspaceId: string;
}

export interface MetricRecordView {
  readonly accountId: string | null;
  readonly createdAt: Date;
  readonly dimensionHash: string;
  readonly id: string;
  readonly importJobId: string | null;
  readonly metricDate: string;
  readonly metricName: string;
  readonly metricValue: string;
  readonly platformCode: PlatformCode;
  readonly source: 'api' | 'csv' | 'manual';
  readonly tenantId: string;
  readonly variantId: string | null;
  readonly workspaceId: string;
}

export interface VisibilityObservationView {
  readonly createdAt: Date;
  readonly evidenceAssetId: string | null;
  readonly id: string;
  readonly isCited: boolean;
  readonly notes: string | null;
  readonly observedAt: Date;
  readonly platformCode: PlatformCode;
  readonly queryHash: string;
  readonly queryText: string;
  readonly rankPosition: number | null;
  readonly tenantId: string;
  readonly workspaceId: string;
}

export interface UsageQueryRow {
  readonly costCategory: string;
  readonly costCents: number;
  readonly currency: string;
  readonly entryCount: number;
  readonly modelKey: string | null;
  readonly packageId: string | null;
  readonly skillName: string | null;
}

export class AnalyticsRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async listImportJobs(scope: AnalyticsScope): Promise<readonly ImportJobView[]> {
    return this.client<ImportJobView[]>`
      SELECT
        import_job.id,
        import_job.tenant_id AS "tenantId",
        import_job.workspace_id AS "workspaceId",
        import_job.source,
        import_job.file_uri AS "fileUri",
        import_job.content_hash AS "contentHash",
        import_job.status,
        import_job.row_count AS "rowCount",
        import_job.error_json AS error,
        import_job.created_by AS "createdBy",
        import_job.created_at AS "createdAt",
        import_job.updated_at AS "updatedAt"
      FROM import_jobs AS import_job
      WHERE import_job.tenant_id = ${scope.tenantId}::uuid
        AND import_job.workspace_id = ${scope.workspaceId}::uuid
        AND has_project_scope_access(
          import_job.tenant_id,
          import_job.workspace_id,
          NULL,
          ${scope.userId}::uuid
        )
      ORDER BY import_job.created_at DESC, import_job.id
    `;
  }

  public async listMetrics(
    scope: AnalyticsScope,
    range: AnalyticsDateRange,
    metricName?: string,
  ): Promise<readonly MetricRecordView[]> {
    return this.client<MetricRecordView[]>`
      SELECT
        metric.id,
        metric.tenant_id AS "tenantId",
        metric.workspace_id AS "workspaceId",
        metric.import_job_id AS "importJobId",
        metric.platform_code AS "platformCode",
        metric.account_id AS "accountId",
        metric.variant_id AS "variantId",
        metric.metric_date::text AS "metricDate",
        metric.metric_name AS "metricName",
        metric.metric_value::text AS "metricValue",
        metric.source,
        metric.dimension_hash AS "dimensionHash",
        metric.created_at AS "createdAt"
      FROM metric_records AS metric
      LEFT JOIN content_variants AS variant
        ON variant.id = metric.variant_id AND variant.tenant_id = metric.tenant_id
      LEFT JOIN content_packages AS package
        ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
      WHERE metric.tenant_id = ${scope.tenantId}::uuid
        AND metric.workspace_id = ${scope.workspaceId}::uuid
        AND metric.metric_date BETWEEN ${range.from}::date AND ${range.to}::date
        AND (${metricName ?? null}::varchar IS NULL OR metric.metric_name = ${metricName ?? null})
        AND has_project_scope_access(
          metric.tenant_id,
          metric.workspace_id,
          package.project_id,
          ${scope.userId}::uuid
        )
      ORDER BY metric.metric_date DESC, metric.platform_code, metric.metric_name, metric.id
    `;
  }

  public async listVisibility(
    scope: AnalyticsScope,
    queryHash?: string,
  ): Promise<readonly VisibilityObservationView[]> {
    return this.client<VisibilityObservationView[]>`
      SELECT
        observation.id,
        observation.tenant_id AS "tenantId",
        observation.workspace_id AS "workspaceId",
        observation.platform_code AS "platformCode",
        observation.query_text AS "queryText",
        observation.query_hash AS "queryHash",
        observation.observed_at AS "observedAt",
        observation.rank_position AS "rankPosition",
        observation.is_cited AS "isCited",
        observation.evidence_asset_id AS "evidenceAssetId",
        observation.notes,
        observation.created_at AS "createdAt"
      FROM visibility_observations AS observation
      WHERE observation.tenant_id = ${scope.tenantId}::uuid
        AND observation.workspace_id = ${scope.workspaceId}::uuid
        AND (${queryHash ?? null}::char(64) IS NULL OR observation.query_hash = ${queryHash ?? null})
        AND has_project_scope_access(
          observation.tenant_id,
          observation.workspace_id,
          NULL,
          ${scope.userId}::uuid
        )
      ORDER BY observation.observed_at DESC, observation.id
    `;
  }

  public async summarizeUsage(
    scope: AnalyticsScope,
    from: Date,
    to: Date,
  ): Promise<readonly UsageQueryRow[]> {
    return this.client<UsageQueryRow[]>`
      WITH effective_usage AS (
        SELECT DISTINCT ON (entry.tenant_id, entry.request_id, entry.cost_category)
          entry.*
        FROM usage_ledger AS entry
        WHERE entry.tenant_id = ${scope.tenantId}::uuid
          AND entry.workspace_id = ${scope.workspaceId}::uuid
          AND entry.created_at >= ${from}
          AND entry.created_at < ${to}
          AND entry.status IN ('estimated', 'settled')
          AND NOT EXISTS (
            SELECT 1
            FROM usage_ledger AS reversal
            WHERE reversal.tenant_id = entry.tenant_id
              AND reversal.reverses_ledger_id = entry.id
              AND reversal.status = 'reversed'
          )
        ORDER BY
          entry.tenant_id,
          entry.request_id,
          entry.cost_category,
          CASE entry.status WHEN 'settled' THEN 0 ELSE 1 END,
          entry.created_at DESC,
          entry.id
      )
      SELECT
        usage.package_id AS "packageId",
        usage.cost_category AS "costCategory",
        usage.model_key AS "modelKey",
        usage.skill_name AS "skillName",
        usage.currency,
        sum(usage.cost_cents)::integer AS "costCents",
        count(*)::integer AS "entryCount"
      FROM effective_usage AS usage
      WHERE has_project_scope_access(
        usage.tenant_id,
        usage.workspace_id,
        usage.project_id,
        ${scope.userId}::uuid
      )
      GROUP BY
        usage.package_id,
        usage.cost_category,
        usage.model_key,
        usage.skill_name,
        usage.currency
      ORDER BY usage.package_id NULLS FIRST, usage.cost_category, usage.model_key, usage.skill_name
    `;
  }
}
