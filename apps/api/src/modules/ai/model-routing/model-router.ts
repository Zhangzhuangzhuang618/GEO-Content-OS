import type { ModelAdapter, ModelUsage } from '@geo-content-os/adapter-model';
import { UuidSchema } from '@geo-content-os/contracts';

import type { BudgetReservationRepository } from './budget-reservation.repository.js';
import type { ModelRateCardRepository } from './model-rate-card.repository.js';
import { ModelRoutingError } from './model-routing.errors.js';
import type {
  BudgetReservation,
  ModelCostEstimate,
  ModelCostEstimateRequest,
  ModelRoute,
  ReverseReservationInput,
  SettleReservationInput,
} from './model-routing.types.js';

const TOKENS_PER_RATE_UNIT = 1_000_000n;
const MICROS_PER_CENT = 10_000n;

export class ModelRouter {
  private readonly routes = new Map<string, ModelRoute>();

  public constructor(
    routes: readonly ModelRoute[],
    private readonly rateCards: ModelRateCardRepository,
    private readonly reservations: BudgetReservationRepository,
  ) {
    for (const route of routes) {
      if (
        route.adapter.modelKey !== route.modelKey ||
        !identifier(route.modelKey, 80) ||
        !identifier(route.provider, 80) ||
        !identifier(route.providerModelId, 160) ||
        this.routes.has(route.modelKey)
      ) {
        throw new TypeError('Model route is invalid or duplicated');
      }
      this.routes.set(route.modelKey, Object.freeze({ ...route }));
    }
  }

  public resolve(modelKey: string): ModelAdapter {
    const route = this.routes.get(modelKey);
    if (!route) throw new ModelRoutingError('MODEL_ROUTE_NOT_FOUND', 'Model route was not found');
    return route.adapter;
  }

  public estimate(input: ModelCostEstimateRequest): ModelCostEstimate {
    UuidSchema.parse(input.tenantId);
    if (
      !identifier(input.requestId, 80) ||
      !Number.isSafeInteger(input.estimatedInputTokens) ||
      input.estimatedInputTokens < 0 ||
      !Number.isSafeInteger(input.maxOutputTokens) ||
      input.maxOutputTokens < 1
    ) {
      throw new ModelRoutingError('USAGE_INVALID', 'Model estimate input is invalid');
    }
    const route = this.routes.get(input.modelKey);
    if (!route) throw new ModelRoutingError('MODEL_ROUTE_NOT_FOUND', 'Model route was not found');
    const at = input.at ?? new Date();
    if (!Number.isFinite(at.getTime())) {
      throw new ModelRoutingError('USAGE_INVALID', 'Model estimate time is invalid');
    }
    const rateCard = this.rateCards.findEffective(input.modelKey, at);
    if (!rateCard) {
      throw new ModelRoutingError('RATE_CARD_NOT_FOUND', 'Effective model rate card was not found');
    }
    if (
      rateCard.provider !== route.provider ||
      rateCard.providerModelId !== route.providerModelId ||
      input.maxOutputTokens > route.adapter.capabilities().maxOutputTokens ||
      input.maxOutputTokens > rateCard.capabilities.maxOutputTokens
    ) {
      throw new ModelRoutingError(
        'RATE_CARD_CONFLICT',
        'Model route and effective rate card do not match',
      );
    }
    const estimatedCostMicros = calculateCostMicros(
      input.estimatedInputTokens,
      input.maxOutputTokens,
      rateCard.inputRateMicros,
      rateCard.outputRateMicros,
    );
    return Object.freeze({
      currency: rateCard.currency,
      estimatedCostCents: microsToCents(estimatedCostMicros),
      estimatedCostMicros,
      estimatedAt: new Date(at),
      estimatedInputTokens: input.estimatedInputTokens,
      maxOutputTokens: input.maxOutputTokens,
      modelKey: input.modelKey,
      provider: route.provider,
      providerModelId: route.providerModelId,
      rateCard,
      requestId: input.requestId,
      tenantId: input.tenantId,
    });
  }

  public reserve(estimate: ModelCostEstimate): BudgetReservation {
    this.assertEstimate(estimate);
    return this.reservations.reserve(estimate);
  }

  public settle(input: SettleReservationInput): BudgetReservation {
    const reservation = this.reservations.find(input.reservationId);
    if (!reservation) {
      throw new ModelRoutingError('RESERVATION_NOT_FOUND', 'Budget reservation was not found');
    }
    assertUsageMatches(input.usage, reservation);
    const actualCostMicros = calculateCostMicros(
      input.usage.inputTokens,
      input.usage.outputTokens,
      reservation.estimate.rateCard.inputRateMicros,
      reservation.estimate.rateCard.outputRateMicros,
    );
    return this.reservations.settle(
      input.reservationId,
      actualCostMicros,
      microsToCents(actualCostMicros),
    );
  }

  public reverse(input: ReverseReservationInput): BudgetReservation {
    if (!input.reason.trim() || input.reason.length > 500) {
      throw new ModelRoutingError('USAGE_INVALID', 'Budget reversal reason is invalid');
    }
    return this.reservations.reverse(input.reservationId, input.reason.trim());
  }

  private assertEstimate(estimate: ModelCostEstimate): void {
    const route = this.routes.get(estimate.modelKey);
    const rateCard = this.rateCards.findById(estimate.rateCard.id);
    const estimatedAt =
      estimate.estimatedAt instanceof Date ? estimate.estimatedAt.getTime() : Number.NaN;
    if (
      !route ||
      !rateCard ||
      route.provider !== estimate.provider ||
      route.providerModelId !== estimate.providerModelId ||
      !sameRateCard(rateCard, estimate.rateCard) ||
      !Number.isFinite(estimatedAt) ||
      rateCard.effectiveFrom.getTime() > estimatedAt ||
      (rateCard.effectiveTo !== null && rateCard.effectiveTo.getTime() <= estimatedAt)
    ) {
      throw new ModelRoutingError('RATE_CARD_CONFLICT', 'Model estimate is not trusted');
    }
    const expectedMicros = calculateCostMicros(
      estimate.estimatedInputTokens,
      estimate.maxOutputTokens,
      rateCard.inputRateMicros,
      rateCard.outputRateMicros,
    );
    if (
      expectedMicros !== estimate.estimatedCostMicros ||
      microsToCents(expectedMicros) !== estimate.estimatedCostCents ||
      estimate.currency !== rateCard.currency
    ) {
      throw new ModelRoutingError('RATE_CARD_CONFLICT', 'Model estimate cost is not trusted');
    }
  }
}

function sameRateCard(
  left: ModelCostEstimate['rateCard'],
  right: ModelCostEstimate['rateCard'],
): boolean {
  return (
    left.id === right.id &&
    left.modelKey === right.modelKey &&
    left.provider === right.provider &&
    left.providerModelId === right.providerModelId &&
    left.currency === right.currency &&
    left.inputRateMicros === right.inputRateMicros &&
    left.outputRateMicros === right.outputRateMicros &&
    left.effectiveFrom.getTime() === right.effectiveFrom.getTime() &&
    left.effectiveTo?.getTime() === right.effectiveTo?.getTime() &&
    left.capabilities.maxOutputTokens === right.capabilities.maxOutputTokens &&
    left.capabilities.jsonMode === right.capabilities.jsonMode &&
    left.capabilities.jsonSchema === right.capabilities.jsonSchema &&
    left.capabilities.streaming === right.capabilities.streaming &&
    left.capabilities.toolCalling === right.capabilities.toolCalling
  );
}

export function calculateCostMicros(
  inputTokens: number,
  outputTokens: number,
  inputRateMicros: bigint,
  outputRateMicros: bigint,
): bigint {
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0 ||
    inputRateMicros < 0n ||
    outputRateMicros < 0n
  ) {
    throw new ModelRoutingError('USAGE_INVALID', 'Model tokens or rates are invalid');
  }
  const weighted = BigInt(inputTokens) * inputRateMicros + BigInt(outputTokens) * outputRateMicros;
  return divideCeiling(weighted, TOKENS_PER_RATE_UNIT);
}

function microsToCents(value: bigint): number {
  const cents = divideCeiling(value, MICROS_PER_CENT);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ModelRoutingError('USAGE_INVALID', 'Model cost exceeds supported range');
  }
  return Number(cents);
}

function divideCeiling(value: bigint, divisor: bigint): bigint {
  return value === 0n ? 0n : (value + divisor - 1n) / divisor;
}

function assertUsageMatches(usage: ModelUsage, reservation: BudgetReservation): void {
  if (
    usage.modelKey !== reservation.estimate.modelKey ||
    usage.providerCode !== reservation.estimate.provider ||
    usage.providerModelId !== reservation.estimate.providerModelId ||
    !Number.isSafeInteger(usage.inputTokens) ||
    usage.inputTokens < 0 ||
    !Number.isSafeInteger(usage.outputTokens) ||
    usage.outputTokens < 0 ||
    usage.totalTokens !== usage.inputTokens + usage.outputTokens
  ) {
    throw new ModelRoutingError('USAGE_INVALID', 'Model usage does not match the reservation');
  }
}

function identifier(value: string, maximum: number): boolean {
  return value.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value);
}
