import { UuidSchema, WorkspaceSettingsSchema } from '@geo-content-os/contracts';
import type { TransactionSql } from 'postgres';

import type { DatabaseClient } from '../../../database/index.js';
import { CostQueryStateError, CostQueryValidationError } from './cost-query.errors.js';
import type {
  CostBreakdownItem,
  CostFilter,
  CostQueryScope,
  CostReport,
  CostTotal,
  PackageCostTotal,
  ProviderReconciliationItem,
  ProviderReconciliationReport,
  ProviderStatementLine,
  WorkspaceBudgetQuery,
  WorkspaceBudgetStatus,
} from './cost-query.types.js';

interface NormalizedFilter {
  readonly currency: string | null;
  readonly from: Date;
  readonly generationRunId: string | null;
  readonly packageId: string | null;
  readonly projectId: string | null;
  readonly to: Date;
  readonly variantId: string | null;
  readonly workspaceId: string | null;
}

interface CostRow {
  readonly costCategory: CostBreakdownItem['costCategory'];
  readonly costCents: string;
  readonly currency: string;
  readonly entryCount: number;
  readonly generationRunId: string | null;
  readonly modelKey: string | null;
  readonly packageId: string | null;
  readonly projectId: string | null;
  readonly provider: string | null;
  readonly skillName: string | null;
  readonly variantId: string | null;
  readonly workspaceId: string | null;
}

interface BudgetRow {
  readonly consumedCents: string;
  readonly settings: unknown;
}

interface ProviderCostRow {
  readonly costCents: string;
  readonly currency: string;
  readonly provider: string | null;
}

const CURRENCY = /^[A-Z]{3}$/u;
const MONTH = /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/u;

interface CostQueryDatabaseProvider {
  readonly client: DatabaseClient;
}

export class CostQueryService {
  public constructor(private readonly client: DatabaseClient | CostQueryDatabaseProvider) {}

  public async report(scope: CostQueryScope, filter: CostFilter): Promise<CostReport> {
    const normalizedScope = normalizeScope(scope);
    const normalized = normalizeFilter(filter);
    const rows = (await resolveClient(this.client).begin(async (transaction) => {
      await assertCostRole(transaction, normalizedScope);
      return queryBreakdown(transaction, normalizedScope, normalized);
    })) as CostRow[];
    const breakdown = Object.freeze(rows.map(toBreakdown));
    return Object.freeze({
      breakdown,
      packageTotals: aggregatePackages(breakdown),
      settledOnly: true,
      totals: aggregateTotals(breakdown),
    });
  }

  public async budget(
    scope: CostQueryScope,
    query: WorkspaceBudgetQuery,
  ): Promise<WorkspaceBudgetStatus> {
    const normalizedScope = normalizeScope(scope);
    const workspaceId = normalizeUuid(query.workspaceId);
    if (!MONTH.test(query.month)) throw new CostQueryValidationError();
    const rows = (await resolveClient(this.client).begin(async (transaction) => {
      await assertCostRole(transaction, normalizedScope);
      return transaction<BudgetRow[]>`
        SELECT
          workspace.settings_json AS settings,
          COALESCE(sum(entry.cost_cents) FILTER (
            WHERE entry.status = 'settled'
              AND entry.currency = 'CNY'
              AND entry.created_at >= (${`${query.month}-01`}::date AT TIME ZONE workspace.timezone)
              AND entry.created_at < ((${`${query.month}-01`}::date + INTERVAL '1 month') AT TIME ZONE workspace.timezone)
              AND NOT EXISTS (
                SELECT 1 FROM usage_ledger AS reversal
                WHERE reversal.tenant_id = entry.tenant_id
                  AND reversal.reverses_ledger_id = entry.id
                  AND reversal.status = 'reversed'
              )
              AND has_project_scope_access(
                entry.tenant_id, entry.workspace_id, entry.project_id, ${normalizedScope.userId}::uuid
              )
          ), 0)::text AS "consumedCents"
        FROM workspaces AS workspace
        LEFT JOIN usage_ledger AS entry
          ON entry.tenant_id = workspace.tenant_id
          AND entry.workspace_id = workspace.id
        WHERE workspace.tenant_id = ${normalizedScope.tenantId}::uuid
          AND workspace.id = ${workspaceId}::uuid
          AND workspace.status = 'active'
          AND workspace.deleted_at IS NULL
          AND has_project_scope_access(
            workspace.tenant_id, workspace.id, NULL, ${normalizedScope.userId}::uuid
          )
        GROUP BY workspace.id
      `;
    })) as BudgetRow[];
    const row = rows[0];
    if (!row) throw new CostQueryStateError();
    const settings = WorkspaceSettingsSchema.safeParse(normalizeWorkspaceSettings(row.settings));
    if (!settings.success) throw new CostQueryStateError('Workspace budget settings are invalid');
    const consumedCents = safeInteger(row.consumedCents);
    const policy = settings.data.budget_policy;
    const limitCents =
      policy?.monthly_limit_cny === null || policy?.monthly_limit_cny === undefined
        ? null
        : toCents(policy.monthly_limit_cny);
    const remainingCents = limitCents === null ? null : Math.max(0, limitCents - consumedCents);
    return Object.freeze({
      consumedCents,
      currency: 'CNY',
      hardLimit: policy?.hard_limit ?? false,
      isExceeded: limitCents !== null && consumedCents > limitCents,
      isExhausted: limitCents !== null && consumedCents >= limitCents,
      limitCents,
      month: query.month,
      remainingCents,
      workspaceId,
    });
  }

  public async reconcileProviders(
    scope: CostQueryScope,
    filter: CostFilter,
    statementLines: readonly ProviderStatementLine[],
  ): Promise<ProviderReconciliationReport> {
    const normalizedScope = normalizeScope(scope);
    const normalized = normalizeFilter(filter);
    const statements = normalizeStatements(statementLines);
    const ledgerRows = (await resolveClient(this.client).begin(async (transaction) => {
      await assertCostRole(transaction, normalizedScope);
      return queryProviderCosts(transaction, normalizedScope, normalized);
    })) as ProviderCostRow[];
    return Object.freeze({
      from: normalized.from.toISOString(),
      items: reconcile(ledgerRows, statements),
      settledOnly: true,
      to: normalized.to.toISOString(),
    });
  }
}

async function assertCostRole(transaction: TransactionSql, scope: CostQueryScope): Promise<void> {
  const rows = await transaction<{ allowed: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM memberships AS membership
      JOIN users AS identity_user ON identity_user.id = membership.user_id
      JOIN tenants AS tenant ON tenant.id = membership.tenant_id
      WHERE membership.tenant_id = ${scope.tenantId}::uuid
        AND membership.user_id = ${scope.userId}::uuid
        AND membership.status = 'active'
        AND membership.role_code IN ('tenant_owner', 'tenant_admin', 'analyst')
        AND identity_user.status = 'active'
        AND identity_user.deleted_at IS NULL
        AND tenant.status = 'active'
        AND tenant.deleted_at IS NULL
    ) AS allowed
  `;
  if (rows[0]?.allowed !== true) throw new CostQueryStateError();
}

function queryBreakdown(
  transaction: TransactionSql,
  scope: CostQueryScope,
  filter: NormalizedFilter,
): Promise<CostRow[]> {
  return transaction<CostRow[]>`
    SELECT
      entry.workspace_id AS "workspaceId",
      entry.project_id AS "projectId",
      entry.package_id AS "packageId",
      entry.variant_id AS "variantId",
      entry.generation_run_id AS "generationRunId",
      entry.cost_category AS "costCategory",
      entry.provider,
      entry.model_key AS "modelKey",
      entry.skill_name AS "skillName",
      entry.currency,
      sum(entry.cost_cents)::text AS "costCents",
      count(*)::integer AS "entryCount"
    FROM usage_ledger AS entry
    WHERE entry.tenant_id = ${scope.tenantId}::uuid
      AND entry.status = 'settled'
      AND entry.created_at >= ${filter.from}
      AND entry.created_at < ${filter.to}
      AND (${filter.workspaceId}::uuid IS NULL OR entry.workspace_id = ${filter.workspaceId}::uuid)
      AND (${filter.projectId}::uuid IS NULL OR entry.project_id = ${filter.projectId}::uuid)
      AND (${filter.packageId}::uuid IS NULL OR entry.package_id = ${filter.packageId}::uuid)
      AND (${filter.variantId}::uuid IS NULL OR entry.variant_id = ${filter.variantId}::uuid)
      AND (${filter.generationRunId}::uuid IS NULL OR entry.generation_run_id = ${filter.generationRunId}::uuid)
      AND (${filter.currency}::char(3) IS NULL OR entry.currency = ${filter.currency})
      AND NOT EXISTS (
        SELECT 1 FROM usage_ledger AS reversal
        WHERE reversal.tenant_id = entry.tenant_id
          AND reversal.reverses_ledger_id = entry.id
          AND reversal.status = 'reversed'
      )
      AND has_project_scope_access(
        entry.tenant_id, entry.workspace_id, entry.project_id, ${scope.userId}::uuid
      )
    GROUP BY
      entry.workspace_id, entry.project_id, entry.package_id, entry.variant_id,
      entry.generation_run_id, entry.cost_category, entry.provider, entry.model_key,
      entry.skill_name, entry.currency
    ORDER BY
      entry.currency, entry.workspace_id NULLS FIRST, entry.project_id NULLS FIRST,
      entry.package_id NULLS FIRST, entry.variant_id NULLS FIRST,
      entry.generation_run_id NULLS FIRST, entry.cost_category, entry.provider NULLS FIRST,
      entry.model_key NULLS FIRST, entry.skill_name NULLS FIRST
  `;
}

function queryProviderCosts(
  transaction: TransactionSql,
  scope: CostQueryScope,
  filter: NormalizedFilter,
): Promise<ProviderCostRow[]> {
  return transaction<ProviderCostRow[]>`
    SELECT entry.provider, entry.currency, sum(entry.cost_cents)::text AS "costCents"
    FROM usage_ledger AS entry
    WHERE entry.tenant_id = ${scope.tenantId}::uuid
      AND entry.status = 'settled'
      AND entry.created_at >= ${filter.from}
      AND entry.created_at < ${filter.to}
      AND (${filter.workspaceId}::uuid IS NULL OR entry.workspace_id = ${filter.workspaceId}::uuid)
      AND (${filter.projectId}::uuid IS NULL OR entry.project_id = ${filter.projectId}::uuid)
      AND (${filter.packageId}::uuid IS NULL OR entry.package_id = ${filter.packageId}::uuid)
      AND (${filter.variantId}::uuid IS NULL OR entry.variant_id = ${filter.variantId}::uuid)
      AND (${filter.generationRunId}::uuid IS NULL OR entry.generation_run_id = ${filter.generationRunId}::uuid)
      AND (${filter.currency}::char(3) IS NULL OR entry.currency = ${filter.currency})
      AND NOT EXISTS (
        SELECT 1 FROM usage_ledger AS reversal
        WHERE reversal.tenant_id = entry.tenant_id
          AND reversal.reverses_ledger_id = entry.id
          AND reversal.status = 'reversed'
      )
      AND has_project_scope_access(
        entry.tenant_id, entry.workspace_id, entry.project_id, ${scope.userId}::uuid
      )
    GROUP BY entry.provider, entry.currency
    ORDER BY entry.currency, entry.provider NULLS FIRST
  `;
}

function normalizeScope(scope: CostQueryScope): CostQueryScope {
  return Object.freeze({
    tenantId: normalizeUuid(scope.tenantId),
    userId: normalizeUuid(scope.userId),
  });
}

function normalizeFilter(filter: CostFilter): NormalizedFilter {
  const from = new Date(filter.from);
  const to = new Date(filter.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw new CostQueryValidationError();
  }
  return Object.freeze({
    currency: filter.currency === undefined ? null : normalizeCurrency(filter.currency),
    from,
    generationRunId: optionalUuid(filter.generationRunId),
    packageId: optionalUuid(filter.packageId),
    projectId: optionalUuid(filter.projectId),
    to,
    variantId: optionalUuid(filter.variantId),
    workspaceId: optionalUuid(filter.workspaceId),
  });
}

function normalizeStatements(
  lines: readonly ProviderStatementLine[],
): readonly ProviderStatementLine[] {
  const keys = new Set<string>();
  return Object.freeze(
    lines.map((line) => {
      const provider = line.provider.trim();
      const currency = normalizeCurrency(line.currency);
      if (
        provider.length < 1 ||
        provider.length > 80 ||
        !Number.isSafeInteger(line.billedCostCents) ||
        line.billedCostCents < 0
      ) {
        throw new CostQueryValidationError();
      }
      const key = `${provider}\u0000${currency}`;
      if (keys.has(key))
        throw new CostQueryValidationError('Provider statement lines must be unique');
      keys.add(key);
      return Object.freeze({ billedCostCents: line.billedCostCents, currency, provider });
    }),
  );
}

function reconcile(
  ledgerRows: readonly ProviderCostRow[],
  statements: readonly ProviderStatementLine[],
): readonly ProviderReconciliationItem[] {
  const ledger = new Map(
    ledgerRows.map((row) => [`${row.provider ?? ''}\u0000${row.currency}`, row] as const),
  );
  const statement = new Map(
    statements.map((line) => [`${line.provider}\u0000${line.currency}`, line] as const),
  );
  const keys = [...new Set([...ledger.keys(), ...statement.keys()])].sort();
  return Object.freeze(
    keys.map((key) => {
      const ledgerRow = ledger.get(key);
      const statementLine = statement.get(key);
      const ledgerCostCents = safeInteger(ledgerRow?.costCents ?? '0');
      const billedCostCents = statementLine?.billedCostCents ?? null;
      const deltaCents = billedCostCents === null ? null : ledgerCostCents - billedCostCents;
      let status: ProviderReconciliationItem['status'];
      if (!ledgerRow) status = 'missing_ledger';
      else if (!statementLine) status = 'missing_statement';
      else status = deltaCents === 0 ? 'matched' : 'mismatch';
      const currency = ledgerRow?.currency ?? statementLine?.currency;
      if (!currency) throw new CostQueryStateError();
      return Object.freeze({
        billedCostCents,
        currency,
        deltaCents,
        ledgerCostCents,
        provider: ledgerRow?.provider ?? statementLine?.provider ?? null,
        status,
      });
    }),
  );
}

function toBreakdown(row: CostRow): CostBreakdownItem {
  return Object.freeze({ ...row, costCents: safeInteger(row.costCents) });
}

function aggregateTotals(rows: readonly CostBreakdownItem[]): readonly CostTotal[] {
  const totals = new Map<string, CostTotal>();
  for (const row of rows) {
    const current = totals.get(row.currency);
    totals.set(row.currency, {
      costCents: (current?.costCents ?? 0) + row.costCents,
      currency: row.currency,
      entryCount: (current?.entryCount ?? 0) + row.entryCount,
    });
  }
  return Object.freeze(
    [...totals.values()]
      .sort((left, right) => left.currency.localeCompare(right.currency))
      .map((total) => Object.freeze(total)),
  );
}

function aggregatePackages(rows: readonly CostBreakdownItem[]): readonly PackageCostTotal[] {
  const totals = new Map<string, PackageCostTotal>();
  for (const row of rows) {
    if (row.packageId === null) continue;
    const key = `${row.packageId}\u0000${row.currency}`;
    const current = totals.get(key);
    totals.set(key, {
      costCents: (current?.costCents ?? 0) + row.costCents,
      currency: row.currency,
      entryCount: (current?.entryCount ?? 0) + row.entryCount,
      packageId: row.packageId,
    });
  }
  return Object.freeze(
    [...totals.values()]
      .sort(
        (left, right) =>
          left.packageId.localeCompare(right.packageId) ||
          left.currency.localeCompare(right.currency),
      )
      .map((total) => Object.freeze(total)),
  );
}

function normalizeUuid(value: string): string {
  const parsed = UuidSchema.safeParse(value);
  if (!parsed.success) throw new CostQueryValidationError();
  return parsed.data;
}

function optionalUuid(value: string | undefined): string | null {
  return value === undefined ? null : normalizeUuid(value);
}

function normalizeCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!CURRENCY.test(currency)) throw new CostQueryValidationError();
  return currency;
}

function safeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new CostQueryStateError('Cost total exceeds safe range');
  return parsed;
}

function resolveClient(database: DatabaseClient | CostQueryDatabaseProvider): DatabaseClient {
  return typeof database === 'function' ? database : database.client;
}

function toCents(value: number): number {
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents)) throw new CostQueryStateError('Budget exceeds safe range');
  return cents;
}

function normalizeWorkspaceSettings(value: unknown): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  ) {
    return { schema_version: 'workspace-settings@1' };
  }
  return value;
}
