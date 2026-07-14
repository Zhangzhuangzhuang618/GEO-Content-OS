import { UuidSchema } from '@geo-content-os/contracts';
import type { TransactionSql } from 'postgres';

import type { DatabaseClient } from '../../../database/index.js';
import { UsageLedgerError } from './usage-ledger.errors.js';
import {
  USAGE_COST_CATEGORIES,
  USAGE_UNITS,
  type UsageAttribution,
  type UsageCostCategory,
  type UsageLedgerEntry,
  type UsageMeasurementInput,
  type UsageReconciliation,
  type UsageReversalInput,
  type UsageSummary,
  type UsageSummaryInput,
} from './usage-ledger.types.js';

interface UsageLedgerRow {
  readonly costCategory: UsageLedgerEntry['costCategory'];
  readonly costCents: number;
  readonly createdAt: Date;
  readonly currency: string;
  readonly generationRunId: string | null;
  readonly id: string;
  readonly inputTokens: number | null;
  readonly modelKey: string | null;
  readonly outputTokens: number | null;
  readonly packageId: string | null;
  readonly projectId: string | null;
  readonly provider: string | null;
  readonly quantity: string;
  readonly requestId: string;
  readonly reversesLedgerId: string | null;
  readonly skillName: string | null;
  readonly status: UsageLedgerEntry['status'];
  readonly tenantId: string;
  readonly unit: UsageLedgerEntry['unit'];
  readonly variantId: string | null;
  readonly workspaceId: string | null;
}

interface NormalizedMeasurement {
  readonly costCategory: UsageCostCategory;
  readonly costCents: number;
  readonly currency: string;
  readonly inputTokens: number | null;
  readonly modelKey: string | null;
  readonly outputTokens: number | null;
  readonly provider: string | null;
  readonly quantity: string;
  readonly requestId: string;
  readonly skillName: string | null;
  readonly unit: UsageLedgerEntry['unit'];
}

const COST_CATEGORIES = new Set<string>(USAGE_COST_CATEGORIES);
const UNITS = new Set<string>(USAGE_UNITS);
const POSTGRES_INTEGER_MAX = 2_147_483_647;

export class UsageLedgerRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async estimate(
    transaction: TransactionSql,
    rawAttribution: UsageAttribution,
    rawInput: UsageMeasurementInput,
  ): Promise<UsageLedgerEntry> {
    const attribution = normalizeAttribution(rawAttribution);
    const input = normalizeMeasurement(rawInput);
    await lockRequest(transaction, attribution.tenantId, input.requestId, input.costCategory);
    const existing = await findLifecycleEntry(
      transaction,
      attribution.tenantId,
      input.requestId,
      input.costCategory,
      'estimated',
    );
    if (existing) {
      if (entryMatches(existing, attribution, input)) return existing;
      throw conflict();
    }
    return insertEntry(transaction, attribution, input, 'estimated', null, input.costCents);
  }

  public async settle(
    transaction: TransactionSql,
    rawAttribution: UsageAttribution,
    rawInput: UsageMeasurementInput,
  ): Promise<UsageLedgerEntry> {
    const attribution = normalizeAttribution(rawAttribution);
    const input = normalizeMeasurement(rawInput);
    await lockRequest(transaction, attribution.tenantId, input.requestId, input.costCategory);
    const existing = await findLifecycleEntry(
      transaction,
      attribution.tenantId,
      input.requestId,
      input.costCategory,
      'settled',
    );
    if (existing) {
      if (entryMatches(existing, attribution, input)) return existing;
      throw conflict();
    }
    const estimate = await findLifecycleEntry(
      transaction,
      attribution.tenantId,
      input.requestId,
      input.costCategory,
      'estimated',
    );
    if (!estimate || !(await entryIsEffective(transaction, estimate.id, attribution.tenantId))) {
      throw new UsageLedgerError(
        'USAGE_STATE_INVALID',
        'Settled usage requires an effective estimate',
      );
    }
    if (!entryIdentityMatches(estimate, attribution, input)) {
      throw conflict();
    }
    return insertEntry(transaction, attribution, input, 'settled', null, input.costCents);
  }

  public async reverse(
    transaction: TransactionSql,
    rawAttribution: UsageAttribution,
    rawInput: UsageReversalInput,
  ): Promise<UsageLedgerEntry> {
    const attribution = normalizeAttribution(rawAttribution);
    const input = normalizeReversal(rawInput);
    await lockRequest(
      transaction,
      attribution.tenantId,
      input.originalRequestId,
      input.costCategory,
    );
    const rows = await findRequestEntries(
      transaction,
      attribution.tenantId,
      input.originalRequestId,
      input.costCategory,
      true,
    );
    const target = lifecycleBase(entriesWithoutReversalRequests(rows));
    if (!target || !attributionMatches(target, attribution)) {
      throw new UsageLedgerError('USAGE_NOT_FOUND', 'Effective usage entry was not found');
    }
    const existingReversal = rows.find((entry) => entry.reversesLedgerId === target.id);
    if (existingReversal) return existingReversal;
    const measurement: NormalizedMeasurement = {
      costCategory: target.costCategory,
      costCents: target.costCents,
      currency: target.currency,
      inputTokens: target.inputTokens,
      modelKey: target.modelKey,
      outputTokens: target.outputTokens,
      provider: target.provider,
      quantity: target.quantity,
      requestId: input.reversalRequestId,
      skillName: target.skillName,
      unit: target.unit,
    };
    return insertEntry(
      transaction,
      attribution,
      measurement,
      'reversed',
      target.id,
      -target.costCents,
    );
  }

  public async reconcile(
    rawAttribution: UsageAttribution,
    rawRequestId: string,
    rawCategory: UsageCostCategory,
  ): Promise<UsageReconciliation> {
    const attribution = normalizeAttribution(rawAttribution);
    const requestId = normalizeRequestId(rawRequestId);
    const costCategory = normalizeCategory(rawCategory);
    const entries = await findRequestEntries(
      this.client,
      attribution.tenantId,
      requestId,
      costCategory,
      false,
    );
    if (entries.length === 0 || entries.some((entry) => !attributionMatches(entry, attribution))) {
      throw new UsageLedgerError('USAGE_NOT_FOUND', 'Usage lifecycle was not found');
    }
    const effective = effectiveEntry(entries);
    const hasReversal = entries.some((entry) => entry.status === 'reversed');
    return Object.freeze({
      effectiveCostCents: effective?.costCents ?? 0,
      effectiveEntry: effective ?? null,
      entries: Object.freeze(entries),
      state: effective?.status ?? (hasReversal ? 'reversed' : 'estimated'),
    });
  }

  public async summarize(rawInput: UsageSummaryInput): Promise<UsageSummary> {
    const attribution = normalizeAttribution(rawInput);
    const currency = normalizeCurrency(rawInput.currency);
    const rows = await this.client<{ effectiveCostCents: string; entryCount: number }[]>`
      WITH ranked AS (
        SELECT
          entry.id,
          entry.cost_cents,
          row_number() OVER (
            PARTITION BY entry.tenant_id, entry.request_id, entry.cost_category
            ORDER BY CASE entry.status WHEN 'settled' THEN 0 ELSE 1 END, entry.created_at DESC, entry.id
          ) AS lifecycle_rank
        FROM usage_ledger AS entry
        WHERE
          entry.tenant_id = ${attribution.tenantId}::uuid
          AND entry.status IN ('estimated', 'settled')
          AND entry.currency = ${currency}
          AND (${attribution.workspaceId}::uuid IS NULL OR entry.workspace_id = ${attribution.workspaceId}::uuid)
          AND (${attribution.projectId}::uuid IS NULL OR entry.project_id = ${attribution.projectId}::uuid)
          AND (${attribution.packageId}::uuid IS NULL OR entry.package_id = ${attribution.packageId}::uuid)
          AND (${attribution.variantId}::uuid IS NULL OR entry.variant_id = ${attribution.variantId}::uuid)
          AND (${attribution.generationRunId}::uuid IS NULL OR entry.generation_run_id = ${attribution.generationRunId}::uuid)
      ), effective AS (
        SELECT ranked.id, ranked.cost_cents
        FROM ranked
        LEFT JOIN usage_ledger AS reversal
          ON reversal.tenant_id = ${attribution.tenantId}::uuid
          AND reversal.reverses_ledger_id = ranked.id
          AND reversal.status = 'reversed'
        WHERE ranked.lifecycle_rank = 1 AND reversal.id IS NULL
      )
      SELECT
        COALESCE(sum(cost_cents), 0)::text AS "effectiveCostCents",
        count(*)::integer AS "entryCount"
      FROM effective
    `;
    return Object.freeze({
      currency,
      effectiveCostCents: safeInteger(rows[0]?.effectiveCostCents ?? '0'),
      entryCount: rows[0]?.entryCount ?? 0,
    });
  }
}

async function insertEntry(
  transaction: TransactionSql,
  attribution: Required<UsageAttribution>,
  input: NormalizedMeasurement,
  status: UsageLedgerEntry['status'],
  reversesLedgerId: string | null,
  costCents: number,
): Promise<UsageLedgerEntry> {
  const rows = await transaction<UsageLedgerRow[]>`
    INSERT INTO usage_ledger (
      tenant_id, workspace_id, project_id, package_id, variant_id, generation_run_id,
      request_id, cost_category, provider, model_key, skill_name, quantity, unit,
      input_tokens, output_tokens, cost_cents, currency, status, reverses_ledger_id
    ) VALUES (
      ${attribution.tenantId}::uuid,
      ${attribution.workspaceId}::uuid,
      ${attribution.projectId}::uuid,
      ${attribution.packageId}::uuid,
      ${attribution.variantId}::uuid,
      ${attribution.generationRunId}::uuid,
      ${input.requestId},
      ${input.costCategory},
      ${input.provider},
      ${input.modelKey},
      ${input.skillName},
      ${input.quantity}::numeric,
      ${input.unit},
      ${input.inputTokens},
      ${input.outputTokens},
      ${costCents},
      ${input.currency},
      ${status},
      ${reversesLedgerId}::uuid
    )
    RETURNING
      id,
      tenant_id AS "tenantId",
      workspace_id AS "workspaceId",
      project_id AS "projectId",
      package_id AS "packageId",
      variant_id AS "variantId",
      generation_run_id AS "generationRunId",
      request_id AS "requestId",
      cost_category AS "costCategory",
      provider,
      model_key AS "modelKey",
      skill_name AS "skillName",
      quantity::text,
      unit,
      input_tokens AS "inputTokens",
      output_tokens AS "outputTokens",
      cost_cents AS "costCents",
      currency,
      status,
      reverses_ledger_id AS "reversesLedgerId",
      created_at AS "createdAt"
  `;
  const row = rows[0];
  if (!row) throw new Error('Usage ledger insert failed');
  return toEntry(row);
}

async function findLifecycleEntry(
  client: DatabaseClient | TransactionSql,
  tenantId: string,
  requestId: string,
  costCategory: UsageCostCategory,
  status: 'estimated' | 'settled',
): Promise<UsageLedgerEntry | undefined> {
  const rows = await client<UsageLedgerRow[]>`
    SELECT
      id,
      tenant_id AS "tenantId",
      workspace_id AS "workspaceId",
      project_id AS "projectId",
      package_id AS "packageId",
      variant_id AS "variantId",
      generation_run_id AS "generationRunId",
      request_id AS "requestId",
      cost_category AS "costCategory",
      provider,
      model_key AS "modelKey",
      skill_name AS "skillName",
      quantity::text,
      unit,
      input_tokens AS "inputTokens",
      output_tokens AS "outputTokens",
      cost_cents AS "costCents",
      currency,
      status,
      reverses_ledger_id AS "reversesLedgerId",
      created_at AS "createdAt"
    FROM usage_ledger
    WHERE
      tenant_id = ${tenantId}::uuid
      AND request_id = ${requestId}
      AND cost_category = ${costCategory}
      AND status = ${status}
    LIMIT 1
  `;
  return rows[0] ? toEntry(rows[0]) : undefined;
}

async function findRequestEntries(
  client: DatabaseClient | TransactionSql,
  tenantId: string,
  requestId: string,
  costCategory: UsageCostCategory,
  forUpdate: boolean,
): Promise<UsageLedgerEntry[]> {
  const rows = await client<UsageLedgerRow[]>`
    SELECT
      entry.id,
      entry.tenant_id AS "tenantId",
      entry.workspace_id AS "workspaceId",
      entry.project_id AS "projectId",
      entry.package_id AS "packageId",
      entry.variant_id AS "variantId",
      entry.generation_run_id AS "generationRunId",
      entry.request_id AS "requestId",
      entry.cost_category AS "costCategory",
      entry.provider,
      entry.model_key AS "modelKey",
      entry.skill_name AS "skillName",
      entry.quantity::text,
      entry.unit,
      entry.input_tokens AS "inputTokens",
      entry.output_tokens AS "outputTokens",
      entry.cost_cents AS "costCents",
      entry.currency,
      entry.status,
      entry.reverses_ledger_id AS "reversesLedgerId",
      entry.created_at AS "createdAt"
    FROM usage_ledger AS entry
    WHERE
      entry.tenant_id = ${tenantId}::uuid
      AND (
        (entry.request_id = ${requestId} AND entry.cost_category = ${costCategory})
        OR entry.reverses_ledger_id IN (
          SELECT original.id
          FROM usage_ledger AS original
          WHERE
            original.tenant_id = ${tenantId}::uuid
            AND original.request_id = ${requestId}
            AND original.cost_category = ${costCategory}
        )
      )
    ORDER BY entry.created_at, entry.id
    ${forUpdate && 'unsafe' in client ? client`FOR UPDATE OF entry` : client``}
  `;
  return rows.map(toEntry);
}

async function entryIsEffective(
  transaction: TransactionSql,
  entryId: string,
  tenantId: string,
): Promise<boolean> {
  const rows = await transaction<{ effective: boolean }[]>`
    SELECT NOT EXISTS (
      SELECT 1 FROM usage_ledger
      WHERE tenant_id = ${tenantId}::uuid
        AND reverses_ledger_id = ${entryId}::uuid
        AND status = 'reversed'
    ) AS effective
  `;
  return rows[0]?.effective === true;
}

async function lockRequest(
  transaction: TransactionSql,
  tenantId: string,
  requestId: string,
  costCategory: UsageCostCategory,
): Promise<void> {
  await transaction`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${tenantId}:${requestId}:${costCategory}`}, 0)
    )
  `;
}

function effectiveEntry(entries: readonly UsageLedgerEntry[]): UsageLedgerEntry | undefined {
  const base = lifecycleBase(entries);
  if (!base || entries.some((entry) => entry.reversesLedgerId === base.id)) return undefined;
  return base;
}

function lifecycleBase(entries: readonly UsageLedgerEntry[]): UsageLedgerEntry | undefined {
  return (
    entries.find((entry) => entry.status === 'settled') ??
    entries.find((entry) => entry.status === 'estimated')
  );
}

function entriesWithoutReversalRequests(
  entries: readonly UsageLedgerEntry[],
): readonly UsageLedgerEntry[] {
  return entries.filter((entry) => entry.status !== 'reversed');
}

function normalizeAttribution(input: UsageAttribution): Required<UsageAttribution> {
  const normalized = {
    generationRunId: input.generationRunId ?? null,
    packageId: input.packageId ?? null,
    projectId: input.projectId ?? null,
    tenantId: input.tenantId,
    variantId: input.variantId ?? null,
    workspaceId: input.workspaceId ?? null,
  };
  for (const id of Object.values(normalized)) {
    if (id !== null) {
      try {
        UuidSchema.parse(id);
      } catch {
        throw new UsageLedgerError('USAGE_SCOPE_INVALID', 'Usage attribution is invalid');
      }
    }
  }
  if (
    (normalized.projectId !== null && normalized.workspaceId === null) ||
    (normalized.packageId !== null &&
      (normalized.workspaceId === null || normalized.projectId === null)) ||
    (normalized.variantId !== null && normalized.packageId === null)
  ) {
    throw new UsageLedgerError('USAGE_SCOPE_INVALID', 'Usage attribution hierarchy is invalid');
  }
  return Object.freeze(normalized);
}

function normalizeMeasurement(input: UsageMeasurementInput): NormalizedMeasurement {
  if (
    !Number.isFinite(input.quantity) ||
    input.quantity < 0 ||
    input.quantity > 999_999_999_999 ||
    !Number.isSafeInteger(input.costCents) ||
    input.costCents < 0 ||
    input.costCents > POSTGRES_INTEGER_MAX ||
    !optionalTokenCount(input.inputTokens) ||
    !optionalTokenCount(input.outputTokens)
  ) {
    throw invalidInput();
  }
  return Object.freeze({
    costCategory: normalizeCategory(input.costCategory),
    costCents: input.costCents,
    currency: normalizeCurrency(input.currency ?? 'CNY'),
    inputTokens: input.inputTokens ?? null,
    modelKey: optionalIdentifier(input.modelKey, 80),
    outputTokens: input.outputTokens ?? null,
    provider: optionalIdentifier(input.provider, 80),
    quantity: input.quantity.toFixed(6),
    requestId: normalizeRequestId(input.requestId),
    skillName: optionalIdentifier(input.skillName, 80),
    unit: normalizeUnit(input.unit),
  });
}

function normalizeReversal(input: UsageReversalInput): UsageReversalInput {
  return Object.freeze({
    costCategory: normalizeCategory(input.costCategory),
    originalRequestId: normalizeRequestId(input.originalRequestId),
    reversalRequestId: normalizeRequestId(input.reversalRequestId),
  });
}

function entryMatches(
  entry: UsageLedgerEntry,
  attribution: Required<UsageAttribution>,
  input: NormalizedMeasurement,
): boolean {
  return (
    entryIdentityMatches(entry, attribution, input) &&
    entry.costCents === input.costCents &&
    entry.inputTokens === input.inputTokens &&
    entry.outputTokens === input.outputTokens &&
    entry.quantity === input.quantity
  );
}

function entryIdentityMatches(
  entry: UsageLedgerEntry,
  attribution: Required<UsageAttribution>,
  input: NormalizedMeasurement,
): boolean {
  return (
    attributionMatches(entry, attribution) &&
    entry.costCategory === input.costCategory &&
    entry.currency === input.currency &&
    entry.modelKey === input.modelKey &&
    entry.provider === input.provider &&
    entry.requestId === input.requestId &&
    entry.skillName === input.skillName &&
    entry.unit === input.unit
  );
}

function attributionMatches(
  entry: UsageLedgerEntry,
  attribution: Required<UsageAttribution>,
): boolean {
  return (
    entry.tenantId === attribution.tenantId &&
    entry.workspaceId === attribution.workspaceId &&
    entry.projectId === attribution.projectId &&
    entry.packageId === attribution.packageId &&
    entry.variantId === attribution.variantId &&
    entry.generationRunId === attribution.generationRunId
  );
}

function toEntry(row: UsageLedgerRow): UsageLedgerEntry {
  return Object.freeze({ ...row });
}

function normalizeRequestId(value: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length < 1 || normalized.length > 80) throw invalidInput();
  return normalized;
}

function normalizeCategory(value: UsageCostCategory): UsageCostCategory {
  if (!COST_CATEGORIES.has(value)) throw invalidInput();
  return value;
}

function normalizeUnit(value: UsageLedgerEntry['unit']): UsageLedgerEntry['unit'] {
  if (!UNITS.has(value)) throw invalidInput();
  return value;
}

function normalizeCurrency(value: string): string {
  if (!/^[A-Z]{3}$/u.test(value)) throw invalidInput();
  return value;
}

function optionalIdentifier(value: string | null | undefined, maximum: number): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > maximum ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(normalized)
  ) {
    throw invalidInput();
  }
  return normalized;
}

function optionalTokenCount(value: number | null | undefined): boolean {
  return (
    value === null ||
    value === undefined ||
    (Number.isSafeInteger(value) && value >= 0 && value <= POSTGRES_INTEGER_MAX)
  );
}

function safeInteger(value: string): number {
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new UsageLedgerError('USAGE_STATE_INVALID', 'Usage summary exceeds supported range');
  }
  return Number(parsed);
}

function invalidInput(): UsageLedgerError {
  return new UsageLedgerError('USAGE_INPUT_INVALID', 'Usage input is invalid');
}

function conflict(): UsageLedgerError {
  return new UsageLedgerError('USAGE_CONFLICT', 'Usage request conflicts with an existing entry');
}
