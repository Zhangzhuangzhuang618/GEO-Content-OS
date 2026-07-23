import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';

import type { DatabaseClient } from '../../../database/index.js';
import type { MetricDefinition, MetricRegistry } from '../repositories/index.js';
import type { AnalyticsQueryCache } from './analytics-query.cache.js';
import type {
  AnalyticsFilter,
  AnalyticsOverview,
  AnalyticsQueryScope,
  ContentAnalyticsItem,
  ContentAnalyticsPage,
  ContentAnalyticsQuery,
  MetricAggregate,
  PlatformAnalytics,
  PlatformAnalyticsResult,
  VisibilityAggregate,
} from './analytics-query.types.js';

const PLATFORM_CODES = new Set([
  'official_site',
  'baijiahao',
  'toutiao',
  'zhihu',
  'xiaohongshu',
  'wechat_mp',
  'douyin',
]);
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface AnalyticsQueryOptions {
  readonly cacheTtlSeconds: number;
  readonly methodologyVersion: string;
}

interface AnalyticsQueryDatabaseProvider {
  readonly client: DatabaseClient;
}

interface MetricRow {
  readonly aggregation: MetricDefinition['aggregation'];
  readonly dataUpdatedAt: Date | string | null;
  readonly metricName: string;
  readonly platformCode?: string;
  readonly unit: string;
  readonly value: string | null;
  readonly variantId?: string;
}

interface VisibilityRow {
  readonly averageRank: string | null;
  readonly citationCount: number;
  readonly dataUpdatedAt: Date | string | null;
  readonly observationCount: number;
  readonly platformCode?: string;
}

interface ContentKeyRow {
  readonly packageCreatedAt: Date | string;
  readonly packageId: string;
  readonly platformCode: string;
  readonly projectId: string;
  readonly variantId: string;
}

interface ContentCursor {
  readonly filterHash: string;
  readonly packageCreatedAt: string;
  readonly packageId: string;
  readonly variantId: string;
}

export class AnalyticsQueryService {
  private readonly definitions: readonly Readonly<MetricDefinition>[];

  public constructor(
    private readonly client: DatabaseClient | AnalyticsQueryDatabaseProvider,
    registry: MetricRegistry,
    private readonly cache: AnalyticsQueryCache | undefined,
    private readonly options: AnalyticsQueryOptions,
  ) {
    if (
      !/^[a-z][a-z0-9._-]{0,63}@\d+$/u.test(options.methodologyVersion) ||
      !Number.isInteger(options.cacheTtlSeconds) ||
      options.cacheTtlSeconds < 1 ||
      options.cacheTtlSeconds > 3_600
    ) {
      throw new AnalyticsQueryValidationError();
    }
    this.definitions = registry.list();
  }

  public async overview(
    scope: AnalyticsQueryScope,
    filter: AnalyticsFilter,
  ): Promise<AnalyticsOverview> {
    const normalized = normalizeFilter(filter);
    return this.cached(scope, 'overview', normalized, async (transaction) => {
      const [metricRows, visibilityRows] = await Promise.all([
        this.queryMetrics(transaction, scope, normalized),
        queryVisibility(transaction, scope, normalized),
      ]);
      const visibility = toVisibilityAggregate(visibilityRows[0]);
      const dataUpdatedAt = maxIso([
        ...metricRows.map((row) => row.dataUpdatedAt),
        visibilityRows[0]?.dataUpdatedAt ?? null,
      ]);
      return Object.freeze({
        dataUpdatedAt,
        methodologyVersion: this.options.methodologyVersion,
        metrics: completeOverviewMetrics(this.definitions, metricRows),
        visibility,
      });
    });
  }

  public async platforms(
    scope: AnalyticsQueryScope,
    filter: AnalyticsFilter,
  ): Promise<PlatformAnalyticsResult> {
    const normalized = normalizeFilter(filter);
    return this.cached(scope, 'platforms', normalized, async (transaction) => {
      const [metricRows, visibilityRows] = await Promise.all([
        this.queryPlatformMetrics(transaction, scope, normalized),
        queryPlatformVisibility(transaction, scope, normalized),
      ]);
      const platformCodes = [
        ...new Set([
          ...metricRows.map((row) => row.platformCode as string),
          ...visibilityRows.map((row) => row.platformCode as string),
        ]),
      ].sort();
      const platforms: PlatformAnalytics[] = platformCodes.map((platformCode) => {
        const platformMetrics = metricRows.filter((row) => row.platformCode === platformCode);
        const visibilityRow = visibilityRows.find((row) => row.platformCode === platformCode);
        return Object.freeze({
          dataUpdatedAt: maxIso([
            ...platformMetrics.map((row) => row.dataUpdatedAt),
            visibilityRow?.dataUpdatedAt ?? null,
          ]),
          metrics: Object.freeze(platformMetrics.map(toMetricAggregate)),
          platformCode,
          visibility: toVisibilityAggregate(visibilityRow),
        });
      });
      return Object.freeze({
        dataUpdatedAt: maxIso(platforms.map((row) => row.dataUpdatedAt)),
        methodologyVersion: this.options.methodologyVersion,
        platforms: Object.freeze(platforms),
      });
    });
  }

  public async contents(
    scope: AnalyticsQueryScope,
    query: ContentAnalyticsQuery,
  ): Promise<ContentAnalyticsPage> {
    const filter = normalizeFilter(query);
    const limit = query.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new AnalyticsQueryValidationError();
    }
    const filterHash = stableHash({ filter, methodologyVersion: this.options.methodologyVersion });
    const cursor = query.cursor ? decodeCursor(query.cursor, filterHash) : undefined;
    const cacheInput = { ...filter, cursor: query.cursor ?? null, limit };
    return this.cached(scope, 'contents', cacheInput, async (transaction) => {
      if (this.definitions.length === 0) {
        return Object.freeze({
          dataUpdatedAt: null,
          items: Object.freeze([]),
          methodologyVersion: this.options.methodologyVersion,
          nextCursor: null,
        });
      }
      const keys = await this.queryContentKeys(transaction, scope, filter, cursor, limit + 1);
      const hasNext = keys.length > limit;
      const pageKeys = keys.slice(0, limit);
      const metricRows = await this.queryContentMetrics(
        transaction,
        scope,
        filter,
        pageKeys.map((row) => row.variantId),
      );
      const items: ContentAnalyticsItem[] = pageKeys.map((key) => {
        const rows = metricRows.filter((row) => row.variantId === key.variantId);
        return Object.freeze({
          dataUpdatedAt: maxIso(rows.map((row) => row.dataUpdatedAt)),
          metrics: Object.freeze(rows.map(toMetricAggregate)),
          packageId: key.packageId,
          platformCode: key.platformCode,
          projectId: key.projectId,
          variantId: key.variantId,
        });
      });
      const last = pageKeys.at(-1);
      return Object.freeze({
        dataUpdatedAt: maxIso(items.map((item) => item.dataUpdatedAt)),
        items: Object.freeze(items),
        methodologyVersion: this.options.methodologyVersion,
        nextCursor:
          hasNext && last
            ? encodeCursor({
                filterHash,
                packageCreatedAt: toIso(last.packageCreatedAt),
                packageId: last.packageId,
                variantId: last.variantId,
              })
            : null,
      });
    });
  }

  private async cached<T>(
    scope: AnalyticsQueryScope,
    namespace: string,
    input: unknown,
    load: (transaction: TransactionSql) => Promise<T>,
  ): Promise<T> {
    const accessFingerprint = (await resolveClient(this.client).begin((transaction) =>
      assertAnalyticsAccess(transaction, scope),
    )) as string;
    const key = `geo:analytics:${stableHash({
      input,
      methodologyVersion: this.options.methodologyVersion,
      namespace,
      scope,
      accessFingerprint,
    })}`;
    if (this.cache) {
      try {
        const value = await this.cache.get(key);
        if (value !== null) return JSON.parse(value) as T;
      } catch {
        // Cache is an optional derived-data accelerator; PostgreSQL remains authoritative.
      }
    }
    const result = (await resolveClient(this.client).begin(async (transaction) => {
      await assertAnalyticsAccess(transaction, scope);
      return load(transaction);
    })) as T;
    if (this.cache) {
      try {
        await this.cache.set(key, JSON.stringify(result), this.options.cacheTtlSeconds);
      } catch {
        // A cache write failure must not fail an otherwise valid analytics read.
      }
    }
    return result;
  }

  private queryMetrics(
    transaction: TransactionSql,
    scope: AnalyticsQueryScope,
    filter: RequiredFilter,
  ): Promise<MetricRow[]> {
    const definitions = definitionArrays(this.definitions);
    return transaction<MetricRow[]>`
      WITH definitions AS (
        SELECT * FROM unnest(
          ${definitions.names}::text[], ${definitions.aggregations}::text[], ${definitions.units}::text[]
        ) AS definition(metric_name, aggregation, unit)
      ), eligible AS (
        SELECT metric.*
        FROM metric_records AS metric
        LEFT JOIN import_jobs AS import_job
          ON import_job.id = metric.import_job_id AND import_job.tenant_id = metric.tenant_id
        LEFT JOIN content_variants AS variant
          ON variant.id = metric.variant_id AND variant.tenant_id = metric.tenant_id
        LEFT JOIN content_packages AS package
          ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
        WHERE metric.tenant_id = ${scope.tenantId}::uuid
          AND metric.workspace_id = ${scope.workspaceId}::uuid
          AND metric.metric_date BETWEEN ${filter.from}::date AND ${filter.to}::date
          AND (cardinality(${filter.platformCodes}::text[]) = 0 OR metric.platform_code = ANY(${filter.platformCodes}::text[]))
          AND (${filter.projectId}::uuid IS NULL OR package.project_id = ${filter.projectId}::uuid)
          AND (metric.import_job_id IS NULL OR import_job.status = 'succeeded')
          AND has_project_scope_access(
            metric.tenant_id, metric.workspace_id, package.project_id, ${scope.userId}::uuid
          )
      )
      SELECT
        definition.metric_name AS "metricName",
        definition.aggregation,
        definition.unit,
        CASE definition.aggregation
          WHEN 'sum' THEN sum(eligible.metric_value)
          WHEN 'average' THEN avg(eligible.metric_value)
          ELSE (array_agg(
            eligible.metric_value ORDER BY eligible.metric_date DESC,
            eligible.created_at DESC, eligible.id DESC
          ))[1]
        END::text AS value,
        max(eligible.created_at) AS "dataUpdatedAt"
      FROM definitions AS definition
      LEFT JOIN eligible ON eligible.metric_name = definition.metric_name
      GROUP BY definition.metric_name, definition.aggregation, definition.unit
      ORDER BY definition.metric_name
    `;
  }

  private queryPlatformMetrics(
    transaction: TransactionSql,
    scope: AnalyticsQueryScope,
    filter: RequiredFilter,
  ): Promise<MetricRow[]> {
    const definitions = definitionArrays(this.definitions);
    return transaction<MetricRow[]>`
      WITH definitions AS (
        SELECT * FROM unnest(
          ${definitions.names}::text[], ${definitions.aggregations}::text[], ${definitions.units}::text[]
        ) AS definition(metric_name, aggregation, unit)
      ), eligible AS (
        SELECT metric.*, package.project_id
        FROM metric_records AS metric
        LEFT JOIN import_jobs AS import_job
          ON import_job.id = metric.import_job_id AND import_job.tenant_id = metric.tenant_id
        LEFT JOIN content_variants AS variant
          ON variant.id = metric.variant_id AND variant.tenant_id = metric.tenant_id
        LEFT JOIN content_packages AS package
          ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
        WHERE metric.tenant_id = ${scope.tenantId}::uuid
          AND metric.workspace_id = ${scope.workspaceId}::uuid
          AND metric.metric_date BETWEEN ${filter.from}::date AND ${filter.to}::date
          AND (cardinality(${filter.platformCodes}::text[]) = 0 OR metric.platform_code = ANY(${filter.platformCodes}::text[]))
          AND (${filter.projectId}::uuid IS NULL OR package.project_id = ${filter.projectId}::uuid)
          AND (metric.import_job_id IS NULL OR import_job.status = 'succeeded')
          AND has_project_scope_access(
            metric.tenant_id, metric.workspace_id, package.project_id, ${scope.userId}::uuid
          )
      )
      SELECT
        eligible.platform_code AS "platformCode",
        definition.metric_name AS "metricName",
        definition.aggregation,
        definition.unit,
        CASE definition.aggregation
          WHEN 'sum' THEN sum(eligible.metric_value)
          WHEN 'average' THEN avg(eligible.metric_value)
          ELSE (array_agg(
            eligible.metric_value ORDER BY eligible.metric_date DESC,
            eligible.created_at DESC, eligible.id DESC
          ))[1]
        END::text AS value,
        max(eligible.created_at) AS "dataUpdatedAt"
      FROM eligible
      JOIN definitions AS definition ON definition.metric_name = eligible.metric_name
      GROUP BY eligible.platform_code, definition.metric_name, definition.aggregation, definition.unit
      ORDER BY eligible.platform_code, definition.metric_name
    `;
  }

  private queryContentKeys(
    transaction: TransactionSql,
    scope: AnalyticsQueryScope,
    filter: RequiredFilter,
    cursor: ContentCursor | undefined,
    limit: number,
  ): Promise<ContentKeyRow[]> {
    const metricNames = this.definitions.map((definition) => definition.name);
    return transaction<ContentKeyRow[]>`
      SELECT
        package.id AS "packageId",
        package.project_id AS "projectId",
        package.created_at AS "packageCreatedAt",
        variant.id AS "variantId",
        variant.platform_code AS "platformCode"
      FROM content_variants AS variant
      JOIN content_packages AS package
        ON package.id = variant.package_id AND package.tenant_id = variant.tenant_id
      WHERE variant.tenant_id = ${scope.tenantId}::uuid
        AND package.workspace_id = ${scope.workspaceId}::uuid
        AND package.deleted_at IS NULL
        AND (cardinality(${filter.platformCodes}::text[]) = 0 OR variant.platform_code = ANY(${filter.platformCodes}::text[]))
        AND (${filter.projectId}::uuid IS NULL OR package.project_id = ${filter.projectId}::uuid)
        AND has_project_scope_access(
          package.tenant_id, package.workspace_id, package.project_id, ${scope.userId}::uuid
        )
        AND EXISTS (
          SELECT 1
          FROM metric_records AS metric
          LEFT JOIN import_jobs AS import_job
            ON import_job.id = metric.import_job_id AND import_job.tenant_id = metric.tenant_id
          WHERE metric.tenant_id = variant.tenant_id
            AND metric.workspace_id = package.workspace_id
            AND metric.variant_id = variant.id
            AND metric.metric_date BETWEEN ${filter.from}::date AND ${filter.to}::date
            AND metric.metric_name = ANY(${metricNames}::text[])
            AND (metric.import_job_id IS NULL OR import_job.status = 'succeeded')
        )
        AND (
          ${cursor?.packageCreatedAt ?? null}::timestamptz IS NULL
          OR (package.created_at, package.id, variant.id) < (
            ${cursor?.packageCreatedAt ?? null}::timestamptz,
            ${cursor?.packageId ?? null}::uuid,
            ${cursor?.variantId ?? null}::uuid
          )
        )
      ORDER BY package.created_at DESC, package.id DESC, variant.id DESC
      LIMIT ${limit}
    `;
  }

  private queryContentMetrics(
    transaction: TransactionSql,
    scope: AnalyticsQueryScope,
    filter: RequiredFilter,
    variantIds: readonly string[],
  ): Promise<MetricRow[]> {
    if (variantIds.length === 0) return Promise.resolve([]);
    const definitions = definitionArrays(this.definitions);
    return transaction<MetricRow[]>`
      WITH definitions AS (
        SELECT * FROM unnest(
          ${definitions.names}::text[], ${definitions.aggregations}::text[], ${definitions.units}::text[]
        ) AS definition(metric_name, aggregation, unit)
      )
      SELECT
        metric.variant_id AS "variantId",
        definition.metric_name AS "metricName",
        definition.aggregation,
        definition.unit,
        CASE definition.aggregation
          WHEN 'sum' THEN sum(metric.metric_value)
          WHEN 'average' THEN avg(metric.metric_value)
          ELSE (array_agg(
            metric.metric_value ORDER BY metric.metric_date DESC,
            metric.created_at DESC, metric.id DESC
          ))[1]
        END::text AS value,
        max(metric.created_at) AS "dataUpdatedAt"
      FROM metric_records AS metric
      JOIN definitions AS definition ON definition.metric_name = metric.metric_name
      LEFT JOIN import_jobs AS import_job
        ON import_job.id = metric.import_job_id AND import_job.tenant_id = metric.tenant_id
      WHERE metric.tenant_id = ${scope.tenantId}::uuid
        AND metric.workspace_id = ${scope.workspaceId}::uuid
        AND metric.variant_id = ANY(${variantIds}::uuid[])
        AND metric.metric_date BETWEEN ${filter.from}::date AND ${filter.to}::date
        AND (metric.import_job_id IS NULL OR import_job.status = 'succeeded')
      GROUP BY metric.variant_id, definition.metric_name, definition.aggregation, definition.unit
      ORDER BY metric.variant_id, definition.metric_name
    `;
  }
}

export class AnalyticsQueryValidationError extends Error {}
export class AnalyticsQueryStateError extends Error {}

interface RequiredFilter {
  readonly from: string;
  readonly platformCodes: readonly string[];
  readonly projectId: string | null;
  readonly to: string;
}

function normalizeFilter(filter: AnalyticsFilter): RequiredFilter {
  const platformCodes = [...new Set(filter.platformCodes ?? [])].sort();
  const projectId = filter.projectId?.trim() || null;
  if (
    !validDate(filter.from) ||
    !validDate(filter.to) ||
    filter.from > filter.to ||
    platformCodes.some((code) => !PLATFORM_CODES.has(code)) ||
    (projectId !== null && !UUID.test(projectId))
  ) {
    throw new AnalyticsQueryValidationError();
  }
  return Object.freeze({ from: filter.from, platformCodes, projectId, to: filter.to });
}

async function assertAnalyticsAccess(
  transaction: TransactionSql,
  scope: AnalyticsQueryScope,
): Promise<string> {
  const rows = await transaction<
    {
      readonly membershipUpdatedAt: Date | string;
      readonly roleCode: string;
      readonly scopeFingerprint: string;
      readonly tenantUpdatedAt: Date | string;
      readonly userUpdatedAt: Date | string;
      readonly workspaceUpdatedAt: Date | string;
    }[]
  >`
    SELECT
      membership.role_code AS "roleCode",
      membership.updated_at AS "membershipUpdatedAt",
      identity_user.updated_at AS "userUpdatedAt",
      tenant.updated_at AS "tenantUpdatedAt",
      workspace.updated_at AS "workspaceUpdatedAt",
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'workspace_id', scope.workspace_id,
            'scope', scope.scope_json,
            'updated_at', scope.updated_at
          ) ORDER BY scope.workspace_id
        )::text
        FROM workspace_memberships AS scope
        JOIN workspaces AS scoped_workspace ON scoped_workspace.id = scope.workspace_id
        WHERE scope.user_id = membership.user_id
          AND scoped_workspace.tenant_id = membership.tenant_id
          AND scoped_workspace.deleted_at IS NULL
      ), '[]') AS "scopeFingerprint"
    FROM workspaces AS workspace
    JOIN tenants AS tenant ON tenant.id = workspace.tenant_id
    JOIN memberships AS membership ON membership.tenant_id = workspace.tenant_id
    JOIN users AS identity_user ON identity_user.id = membership.user_id
    WHERE workspace.id = ${scope.workspaceId}::uuid
      AND workspace.tenant_id = ${scope.tenantId}::uuid
      AND workspace.status = 'active'
      AND workspace.deleted_at IS NULL
      AND tenant.status = 'active'
      AND tenant.deleted_at IS NULL
      AND membership.user_id = ${scope.userId}::uuid
      AND membership.status = 'active'
      AND membership.role_code IN ('tenant_owner', 'tenant_admin', 'analyst')
      AND identity_user.status = 'active'
      AND identity_user.deleted_at IS NULL
      AND (
        membership.role_code IN ('tenant_owner', 'tenant_admin')
        OR NOT EXISTS (
          SELECT 1
          FROM workspace_memberships AS any_scope
          JOIN workspaces AS any_workspace ON any_workspace.id = any_scope.workspace_id
          WHERE any_scope.user_id = membership.user_id
            AND any_workspace.tenant_id = membership.tenant_id
            AND any_workspace.deleted_at IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM workspace_memberships AS selected_scope
          WHERE selected_scope.user_id = membership.user_id
            AND selected_scope.workspace_id = workspace.id
        )
      )
  `;
  const access = rows[0];
  if (!access) throw new AnalyticsQueryStateError();
  return stableHash(access);
}

function queryVisibility(
  transaction: TransactionSql,
  scope: AnalyticsQueryScope,
  filter: RequiredFilter,
): Promise<VisibilityRow[]> {
  return transaction<VisibilityRow[]>`
    SELECT
      count(*)::integer AS "observationCount",
      count(*) FILTER (WHERE observation.is_cited)::integer AS "citationCount",
      round(avg(observation.rank_position), 2)::text AS "averageRank",
      max(observation.created_at) AS "dataUpdatedAt"
    FROM visibility_observations AS observation
    WHERE observation.tenant_id = ${scope.tenantId}::uuid
      AND observation.workspace_id = ${scope.workspaceId}::uuid
      AND observation.observed_at >= ${filter.from}::date
      AND observation.observed_at < (${filter.to}::date + INTERVAL '1 day')
      AND (cardinality(${filter.platformCodes}::text[]) = 0 OR observation.platform_code = ANY(${filter.platformCodes}::text[]))
      AND ${filter.projectId}::uuid IS NULL
      AND has_project_scope_access(
        observation.tenant_id, observation.workspace_id, NULL, ${scope.userId}::uuid
      )
  `;
}

function queryPlatformVisibility(
  transaction: TransactionSql,
  scope: AnalyticsQueryScope,
  filter: RequiredFilter,
): Promise<VisibilityRow[]> {
  return transaction<VisibilityRow[]>`
    SELECT
      observation.platform_code AS "platformCode",
      count(*)::integer AS "observationCount",
      count(*) FILTER (WHERE observation.is_cited)::integer AS "citationCount",
      round(avg(observation.rank_position), 2)::text AS "averageRank",
      max(observation.created_at) AS "dataUpdatedAt"
    FROM visibility_observations AS observation
    WHERE observation.tenant_id = ${scope.tenantId}::uuid
      AND observation.workspace_id = ${scope.workspaceId}::uuid
      AND observation.observed_at >= ${filter.from}::date
      AND observation.observed_at < (${filter.to}::date + INTERVAL '1 day')
      AND (cardinality(${filter.platformCodes}::text[]) = 0 OR observation.platform_code = ANY(${filter.platformCodes}::text[]))
      AND ${filter.projectId}::uuid IS NULL
      AND has_project_scope_access(
        observation.tenant_id, observation.workspace_id, NULL, ${scope.userId}::uuid
      )
    GROUP BY observation.platform_code
    ORDER BY observation.platform_code
  `;
}

function completeOverviewMetrics(
  definitions: readonly Readonly<MetricDefinition>[],
  rows: readonly MetricRow[],
): readonly MetricAggregate[] {
  return Object.freeze(
    definitions.map((definition) => {
      const row = rows.find((candidate) => candidate.metricName === definition.name);
      const aggregate = row ? toMetricAggregate(row) : null;
      return Object.freeze({
        aggregation: definition.aggregation,
        name: definition.name,
        unit: definition.unit,
        value: aggregate?.value ?? (definition.aggregation === 'sum' ? 0 : null),
      });
    }),
  );
}

function toMetricAggregate(row: MetricRow): MetricAggregate {
  return Object.freeze({
    aggregation: row.aggregation,
    name: row.metricName,
    unit: row.unit,
    value: row.value === null ? null : Number(row.value),
  });
}

function toVisibilityAggregate(row: VisibilityRow | undefined): VisibilityAggregate {
  const observationCount = row?.observationCount ?? 0;
  const citationCount = row?.citationCount ?? 0;
  return Object.freeze({
    averageRank:
      row?.averageRank === null || row?.averageRank === undefined ? null : Number(row.averageRank),
    citationCount,
    citationRate: observationCount === 0 ? 0 : citationCount / observationCount,
    observationCount,
  });
}

function definitionArrays(definitions: readonly Readonly<MetricDefinition>[]) {
  return {
    aggregations: definitions.map((definition) => definition.aggregation),
    names: definitions.map((definition) => definition.name),
    units: definitions.map((definition) => definition.unit),
  };
}

function maxIso(values: readonly (Date | string | null)[]): string | null {
  let maximum: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    const time = new Date(value).getTime();
    if (!Number.isNaN(time) && (maximum === null || time > maximum)) maximum = time;
  }
  return maximum === null ? null : new Date(maximum).toISOString();
}

function toIso(value: Date | string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new AnalyticsQueryStateError();
  return date.toISOString();
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function encodeCursor(cursor: ContentCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string, filterHash: string): ContentCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!isCursor(parsed)) throw new AnalyticsQueryValidationError('Content cursor is malformed');
    if (parsed.filterHash !== filterHash) {
      throw new AnalyticsQueryValidationError('Content cursor does not match query filters');
    }
    return Object.freeze(parsed);
  } catch (error) {
    if (error instanceof AnalyticsQueryValidationError) throw error;
    throw new AnalyticsQueryValidationError('Content cursor is malformed');
  }
}

function isCursor(value: unknown): value is ContentCursor {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as Partial<ContentCursor>;
  return (
    typeof cursor.filterHash === 'string' &&
    HASH.test(cursor.filterHash) &&
    typeof cursor.packageCreatedAt === 'string' &&
    !Number.isNaN(new Date(cursor.packageCreatedAt).getTime()) &&
    typeof cursor.packageId === 'string' &&
    UUID.test(cursor.packageId) &&
    typeof cursor.variantId === 'string' &&
    UUID.test(cursor.variantId)
  );
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function resolveClient(database: DatabaseClient | AnalyticsQueryDatabaseProvider): DatabaseClient {
  return typeof database === 'function' ? database : database.client;
}
