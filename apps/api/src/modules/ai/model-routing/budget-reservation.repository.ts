import { randomUUID } from 'node:crypto';

import { UuidSchema } from '@geo-content-os/contracts';

import { ModelRoutingError } from './model-routing.errors.js';
import type { BudgetReservation, ModelCostEstimate } from './model-routing.types.js';

export interface BudgetReservationRepository {
  find(id: string): BudgetReservation | undefined;
  reserve(estimate: ModelCostEstimate): BudgetReservation;
  reverse(reservationId: string, reason: string): BudgetReservation;
  settle(
    reservationId: string,
    actualCostMicros: bigint,
    actualCostCents: number,
  ): BudgetReservation;
}

export class InMemoryBudgetReservationRepository implements BudgetReservationRepository {
  private readonly limits = new Map<string, Readonly<{ currency: string; limitCents: number }>>();
  private readonly reservations = new Map<string, BudgetReservation>();
  private readonly requestIndex = new Map<string, string>();

  public setLimit(tenantId: string, currency: string, limitCents: number): void {
    UuidSchema.parse(tenantId);
    if (!/^[A-Z]{3}$/u.test(currency) || !safeCents(limitCents)) {
      throw new TypeError('Budget limit is invalid');
    }
    this.limits.set(tenantId, Object.freeze({ currency, limitCents }));
  }

  public find(id: string): BudgetReservation | undefined {
    return this.reservations.get(id);
  }

  public reserve(estimate: ModelCostEstimate): BudgetReservation {
    const requestKey = `${estimate.tenantId}:${estimate.requestId}`;
    const existingId = this.requestIndex.get(requestKey);
    if (existingId) {
      const existing = this.reservations.get(existingId)!;
      if (sameEstimate(existing.estimate, estimate)) return existing;
      throw new ModelRoutingError(
        'RESERVATION_CONFLICT',
        'Budget request was reused with a different estimate',
      );
    }
    const policy = this.limits.get(estimate.tenantId);
    if (!policy || policy.currency !== estimate.currency) {
      throw new ModelRoutingError('BUDGET_EXCEEDED', 'No matching tenant budget is configured');
    }
    const allocated = this.allocatedCents(estimate.tenantId, estimate.currency);
    if (allocated + estimate.estimatedCostCents > policy.limitCents) {
      throw new ModelRoutingError('BUDGET_EXCEEDED', 'Tenant model budget is insufficient');
    }
    const now = new Date();
    const reservation = Object.freeze({
      actualCostCents: null,
      actualCostMicros: null,
      createdAt: now,
      estimate,
      id: randomUUID(),
      reversalReason: null,
      status: 'estimated' as const,
      updatedAt: now,
    });
    this.reservations.set(reservation.id, reservation);
    this.requestIndex.set(requestKey, reservation.id);
    return reservation;
  }

  public settle(
    reservationId: string,
    actualCostMicros: bigint,
    actualCostCents: number,
  ): BudgetReservation {
    const existing = this.requireEstimated(reservationId);
    if (actualCostMicros < 0n || !safeCents(actualCostCents)) {
      throw new ModelRoutingError('USAGE_INVALID', 'Settled model cost is invalid');
    }
    const settled = Object.freeze({
      ...existing,
      actualCostCents,
      actualCostMicros,
      status: 'settled' as const,
      updatedAt: new Date(),
    });
    this.reservations.set(existing.id, settled);
    return settled;
  }

  public reverse(reservationId: string, reason: string): BudgetReservation {
    const existing = this.reservations.get(reservationId);
    if (!existing) {
      throw new ModelRoutingError('RESERVATION_NOT_FOUND', 'Budget reservation was not found');
    }
    if (existing.status === 'reversed') return existing;
    const reversed = Object.freeze({
      ...existing,
      reversalReason: reason,
      status: 'reversed' as const,
      updatedAt: new Date(),
    });
    this.reservations.set(existing.id, reversed);
    return reversed;
  }

  private requireEstimated(reservationId: string): BudgetReservation {
    const existing = this.reservations.get(reservationId);
    if (!existing) {
      throw new ModelRoutingError('RESERVATION_NOT_FOUND', 'Budget reservation was not found');
    }
    if (existing.status !== 'estimated') {
      throw new ModelRoutingError(
        'RESERVATION_STATE_INVALID',
        'Only an estimated reservation can be settled',
      );
    }
    return existing;
  }

  private allocatedCents(tenantId: string, currency: string): number {
    let total = 0;
    for (const reservation of this.reservations.values()) {
      if (
        reservation.estimate.tenantId !== tenantId ||
        reservation.estimate.currency !== currency ||
        reservation.status === 'reversed'
      ) {
        continue;
      }
      total +=
        reservation.status === 'settled'
          ? (reservation.actualCostCents ?? 0)
          : reservation.estimate.estimatedCostCents;
    }
    return total;
  }
}

function sameEstimate(left: ModelCostEstimate, right: ModelCostEstimate): boolean {
  return (
    left.modelKey === right.modelKey &&
    left.rateCard.id === right.rateCard.id &&
    left.estimatedInputTokens === right.estimatedInputTokens &&
    left.maxOutputTokens === right.maxOutputTokens &&
    left.estimatedCostMicros === right.estimatedCostMicros
  );
}

function safeCents(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
