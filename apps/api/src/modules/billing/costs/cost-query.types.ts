import type { UsageCostCategory } from '../usage/index.js';

export interface CostQueryScope {
  readonly tenantId: string;
  readonly userId: string;
}

export interface CostFilter {
  readonly currency?: string;
  readonly from: string;
  readonly generationRunId?: string;
  readonly packageId?: string;
  readonly projectId?: string;
  readonly to: string;
  readonly variantId?: string;
  readonly workspaceId?: string;
}

export interface CostBreakdownItem {
  readonly costCategory: UsageCostCategory;
  readonly costCents: number;
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

export interface CostTotal {
  readonly costCents: number;
  readonly currency: string;
  readonly entryCount: number;
}

export interface PackageCostTotal extends CostTotal {
  readonly packageId: string;
}

export interface CostReport {
  readonly breakdown: readonly CostBreakdownItem[];
  readonly packageTotals: readonly PackageCostTotal[];
  readonly settledOnly: true;
  readonly totals: readonly CostTotal[];
}

export interface WorkspaceBudgetQuery {
  readonly month: string;
  readonly workspaceId: string;
}

export interface WorkspaceBudgetStatus {
  readonly consumedCents: number;
  readonly currency: 'CNY';
  readonly hardLimit: boolean;
  readonly isExceeded: boolean;
  readonly isExhausted: boolean;
  readonly limitCents: number | null;
  readonly month: string;
  readonly remainingCents: number | null;
  readonly workspaceId: string;
}

export interface ProviderStatementLine {
  readonly billedCostCents: number;
  readonly currency: string;
  readonly provider: string;
}

export interface ProviderReconciliationItem {
  readonly billedCostCents: number | null;
  readonly currency: string;
  readonly deltaCents: number | null;
  readonly ledgerCostCents: number;
  readonly provider: string | null;
  readonly status: 'matched' | 'mismatch' | 'missing_ledger' | 'missing_statement';
}

export interface ProviderReconciliationReport {
  readonly from: string;
  readonly items: readonly ProviderReconciliationItem[];
  readonly settledOnly: true;
  readonly to: string;
}
