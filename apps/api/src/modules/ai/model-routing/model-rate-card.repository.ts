import { UuidSchema } from '@geo-content-os/contracts';

import { ModelRoutingError } from './model-routing.errors.js';
import type { ModelRateCard } from './model-routing.types.js';

export interface ModelRateCardRepository {
  findEffective(modelKey: string, at: Date): ModelRateCard | undefined;
  findById(id: string): ModelRateCard | undefined;
}

export class InMemoryModelRateCardRepository implements ModelRateCardRepository {
  private readonly cards: readonly ModelRateCard[];

  public constructor(cards: readonly ModelRateCard[]) {
    const normalized = cards.map(normalizeRateCard);
    assertNoOverlap(normalized);
    this.cards = Object.freeze(normalized);
  }

  public findEffective(modelKey: string, at: Date): ModelRateCard | undefined {
    const card = this.cards.find(
      (card) =>
        card.modelKey === modelKey &&
        card.effectiveFrom.getTime() <= at.getTime() &&
        (card.effectiveTo === null || card.effectiveTo.getTime() > at.getTime()),
    );
    return card ? cloneRateCard(card) : undefined;
  }

  public findById(id: string): ModelRateCard | undefined {
    const card = this.cards.find((card) => card.id === id);
    return card ? cloneRateCard(card) : undefined;
  }
}

function cloneRateCard(card: ModelRateCard): ModelRateCard {
  return Object.freeze({
    ...card,
    capabilities: Object.freeze({ ...card.capabilities }),
    effectiveFrom: new Date(card.effectiveFrom),
    effectiveTo: card.effectiveTo ? new Date(card.effectiveTo) : null,
  });
}

function normalizeRateCard(card: ModelRateCard): ModelRateCard {
  UuidSchema.parse(card.id);
  const from = card.effectiveFrom.getTime();
  const to = card.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY;
  if (
    !identifier(card.modelKey, 80) ||
    !identifier(card.provider, 80) ||
    !identifier(card.providerModelId, 160) ||
    !/^[A-Z]{3}$/u.test(card.currency) ||
    card.inputRateMicros < 0n ||
    card.outputRateMicros < 0n ||
    !Number.isFinite(from) ||
    to <= from
  ) {
    throw new TypeError('Model rate card is invalid');
  }
  return Object.freeze({
    ...card,
    capabilities: Object.freeze({ ...card.capabilities }),
    effectiveFrom: new Date(from),
    effectiveTo: Number.isFinite(to) ? new Date(to) : null,
  });
}

function assertNoOverlap(cards: readonly ModelRateCard[]): void {
  for (let left = 0; left < cards.length; left += 1) {
    for (let right = left + 1; right < cards.length; right += 1) {
      const first = cards[left]!;
      const second = cards[right]!;
      if (first.id === second.id) {
        throw new ModelRoutingError('RATE_CARD_CONFLICT', 'Model rate card ID is duplicated');
      }
      if (first.modelKey !== second.modelKey) continue;
      const firstEnd = first.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY;
      const secondEnd = second.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY;
      if (first.effectiveFrom.getTime() < secondEnd && second.effectiveFrom.getTime() < firstEnd) {
        throw new ModelRoutingError(
          'RATE_CARD_CONFLICT',
          'Effective model rate card intervals overlap',
        );
      }
    }
  }
}

function identifier(value: string, maximum: number): boolean {
  return value.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value);
}
