import type { ModelAdapter, ModelCapabilities, ModelUsage } from '@geo-content-os/adapter-model';

export interface ModelRoute {
  readonly adapter: ModelAdapter;
  readonly modelKey: string;
  readonly provider: string;
  readonly providerModelId: string;
}

export interface ModelRateCard {
  readonly capabilities: ModelCapabilities;
  readonly currency: string;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  readonly id: string;
  /** Currency micros per one million input tokens. */
  readonly inputRateMicros: bigint;
  readonly modelKey: string;
  /** Currency micros per one million output tokens. */
  readonly outputRateMicros: bigint;
  readonly provider: string;
  readonly providerModelId: string;
}

export interface ModelCostEstimateRequest {
  readonly at?: Date;
  readonly estimatedInputTokens: number;
  readonly maxOutputTokens: number;
  readonly modelKey: string;
  readonly requestId: string;
  readonly tenantId: string;
}

export interface ModelCostEstimate {
  readonly currency: string;
  readonly estimatedCostCents: number;
  readonly estimatedCostMicros: bigint;
  readonly estimatedInputTokens: number;
  readonly estimatedAt: Date;
  readonly maxOutputTokens: number;
  readonly modelKey: string;
  readonly provider: string;
  readonly providerModelId: string;
  readonly rateCard: ModelRateCard;
  readonly requestId: string;
  readonly tenantId: string;
}

export interface BudgetReservation {
  readonly actualCostCents: number | null;
  readonly actualCostMicros: bigint | null;
  readonly createdAt: Date;
  readonly estimate: ModelCostEstimate;
  readonly id: string;
  readonly reversalReason: string | null;
  readonly status: 'estimated' | 'reversed' | 'settled';
  readonly updatedAt: Date;
}

export interface SettleReservationInput {
  readonly reservationId: string;
  readonly usage: ModelUsage;
}

export interface ReverseReservationInput {
  readonly reservationId: string;
  readonly reason: string;
}
