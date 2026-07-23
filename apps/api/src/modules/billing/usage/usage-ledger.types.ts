export const USAGE_COST_CATEGORIES = Object.freeze([
  'llm',
  'embedding',
  'rerank',
  'ocr',
  'storage',
  'queue',
  'platform_api',
  'manual_adjustment',
] as const);

export const USAGE_UNITS = Object.freeze([
  'token',
  'image',
  'page',
  'gb_month',
  'cpu_second',
  'request',
] as const);

export type UsageCostCategory = (typeof USAGE_COST_CATEGORIES)[number];
export type UsageUnit = (typeof USAGE_UNITS)[number];
export type UsageLedgerStatus = 'estimated' | 'reversed' | 'settled';

export interface UsageAttribution {
  readonly generationRunId?: string | null;
  readonly packageId?: string | null;
  readonly projectId?: string | null;
  readonly tenantId: string;
  readonly variantId?: string | null;
  readonly workspaceId?: string | null;
}

export interface UsageMeasurementInput {
  readonly costCategory: UsageCostCategory;
  readonly costCents: number;
  readonly currency?: string;
  readonly inputTokens?: number | null;
  readonly modelKey?: string | null;
  readonly outputTokens?: number | null;
  readonly provider?: string | null;
  readonly quantity: number;
  readonly requestId: string;
  readonly skillName?: string | null;
  readonly unit: UsageUnit;
}

export interface UsageReversalInput {
  readonly costCategory: UsageCostCategory;
  readonly originalRequestId: string;
  readonly reversalRequestId: string;
}

export interface UsageLedgerEntry extends UsageAttribution {
  readonly costCategory: UsageCostCategory;
  readonly costCents: number;
  readonly createdAt: Date;
  readonly currency: string;
  readonly id: string;
  readonly inputTokens: number | null;
  readonly modelKey: string | null;
  readonly outputTokens: number | null;
  readonly provider: string | null;
  readonly quantity: string;
  readonly requestId: string;
  readonly reversesLedgerId: string | null;
  readonly skillName: string | null;
  readonly status: UsageLedgerStatus;
  readonly unit: UsageUnit;
}

export interface UsageReconciliation {
  readonly effectiveCostCents: number;
  readonly effectiveEntry: UsageLedgerEntry | null;
  readonly entries: readonly UsageLedgerEntry[];
  readonly state: UsageLedgerStatus;
}

export interface UsageSummaryInput extends UsageAttribution {
  readonly currency: string;
}

export interface UsageSummary {
  readonly currency: string;
  readonly effectiveCostCents: number;
  readonly entryCount: number;
}
