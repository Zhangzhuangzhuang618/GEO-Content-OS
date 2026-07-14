import { MockModelAdapter, type ModelUsage } from '@geo-content-os/adapter-model';
import { describe, expect, it } from 'vitest';

import {
  InMemoryBudgetReservationRepository,
  InMemoryModelRateCardRepository,
  ModelRouter,
  type ModelCostEstimate,
  type ModelRateCard,
} from './index.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const RATE_CARD_ID = '22222222-2222-4222-8222-222222222222';
const MODEL_KEY = 'deepseek.flash';
const PROVIDER = 'deepseek';
const PROVIDER_MODEL_ID = 'configured-flash-model';
const AT = new Date('2026-07-15T00:00:00.000Z');

describe('ModelRouter', () => {
  it('resolves an adapter and estimates cost from the effective rate card', () => {
    const { router } = setup();

    expect(router.resolve(MODEL_KEY).modelKey).toBe(MODEL_KEY);
    expect(router.estimate(estimateRequest())).toMatchObject({
      currency: 'CNY',
      estimatedCostCents: 200,
      estimatedCostMicros: 2_000_000n,
      modelKey: MODEL_KEY,
      provider: PROVIDER,
      providerModelId: PROVIDER_MODEL_ID,
    });
  });

  it('selects non-overlapping rate intervals and rejects overlaps', () => {
    const oldCard = rateCard({
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: new Date('2026-07-01T00:00:00.000Z'),
      id: '33333333-3333-4333-8333-333333333333',
    });
    const currentCard = rateCard({ effectiveFrom: new Date('2026-07-01T00:00:00.000Z') });
    const repository = new InMemoryModelRateCardRepository([oldCard, currentCard]);

    expect(repository.findEffective(MODEL_KEY, new Date('2026-06-30T23:59:59.999Z'))?.id).toBe(
      oldCard.id,
    );
    expect(repository.findEffective(MODEL_KEY, new Date('2026-07-01T00:00:00.000Z'))?.id).toBe(
      currentCard.id,
    );
    expect(
      () =>
        new InMemoryModelRateCardRepository([
          currentCard,
          rateCard({ id: '44444444-4444-4444-8444-444444444444' }),
        ]),
    ).toThrowError(expect.objectContaining({ code: 'RATE_CARD_CONFLICT' }));
  });

  it('isolates stored rate card dates from caller mutation', () => {
    const repository = new InMemoryModelRateCardRepository([rateCard()]);
    const returned = repository.findById(RATE_CARD_ID)!;

    returned.effectiveFrom.setUTCFullYear(2030);

    expect(repository.findById(RATE_CARD_ID)?.effectiveFrom.toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('reserves budget idempotently and rejects request conflicts or excess', () => {
    const { budgets, router } = setup(250);
    const estimate = router.estimate(estimateRequest());

    const first = router.reserve(estimate);
    expect(router.reserve(estimate).id).toBe(first.id);
    expect(() =>
      router.reserve({ ...estimate, estimatedInputTokens: 500_001 } as ModelCostEstimate),
    ).toThrowError(expect.objectContaining({ code: 'RATE_CARD_CONFLICT' }));

    const second = router.estimate(estimateRequest({ requestId: 'request-2' }));
    expect(() => router.reserve(second)).toThrowError(
      expect.objectContaining({ code: 'BUDGET_EXCEEDED' }),
    );
    expect(budgets.find(first.id)?.status).toBe('estimated');
  });

  it('settles actual usage and releases unused budget', () => {
    const { router } = setup(250);
    const first = router.reserve(router.estimate(estimateRequest()));

    const settled = router.settle({
      reservationId: first.id,
      usage: usage({ inputTokens: 500_000, outputTokens: 250_000, totalTokens: 750_000 }),
    });

    expect(settled).toMatchObject({
      actualCostCents: 100,
      actualCostMicros: 1_000_000n,
      status: 'settled',
    });
    const next = router.estimate(
      estimateRequest({
        estimatedInputTokens: 250_000,
        maxOutputTokens: 500_000,
        requestId: 'next',
      }),
    );
    expect(router.reserve(next).status).toBe('estimated');
  });

  it('records actual overage and blocks later reservations', () => {
    const { router } = setup(250);
    const reservation = router.reserve(router.estimate(estimateRequest()));

    router.settle({
      reservationId: reservation.id,
      usage: usage({ inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 }),
    });

    const small = router.estimate(
      estimateRequest({ estimatedInputTokens: 0, maxOutputTokens: 1, requestId: 'small' }),
    );
    expect(() => router.reserve(small)).toThrowError(
      expect.objectContaining({ code: 'BUDGET_EXCEEDED' }),
    );
  });

  it('reverses reservations idempotently and releases their budget', () => {
    const { router } = setup(200);
    const reservation = router.reserve(router.estimate(estimateRequest()));

    const reversed = router.reverse({
      reason: 'provider request failed',
      reservationId: reservation.id,
    });

    expect(reversed).toMatchObject({
      reversalReason: 'provider request failed',
      status: 'reversed',
    });
    expect(
      router.reverse({ reason: 'ignored retry reason', reservationId: reservation.id }).id,
    ).toBe(reservation.id);
    const next = router.estimate(estimateRequest({ requestId: 'next' }));
    expect(router.reserve(next).status).toBe('estimated');
  });

  it('rejects forged estimates, mismatched usage, and route capability violations', () => {
    const { router } = setup();
    const estimate = router.estimate(estimateRequest());
    const forged = {
      ...estimate,
      estimatedCostCents: 0,
      estimatedCostMicros: 0n,
    } as ModelCostEstimate;

    expect(() => router.reserve(forged)).toThrowError(
      expect.objectContaining({ code: 'RATE_CARD_CONFLICT' }),
    );
    const reservation = router.reserve(estimate);
    expect(() =>
      router.settle({
        reservationId: reservation.id,
        usage: usage({ providerModelId: 'other-provider-model' }),
      }),
    ).toThrowError(expect.objectContaining({ code: 'USAGE_INVALID' }));
    expect(() => router.estimate(estimateRequest({ maxOutputTokens: 1_000_001 }))).toThrowError(
      expect.objectContaining({ code: 'RATE_CARD_CONFLICT' }),
    );
  });
});

function setup(limitCents = 10_000): {
  readonly budgets: InMemoryBudgetReservationRepository;
  readonly router: ModelRouter;
} {
  const adapter = new MockModelAdapter({
    capabilities: { maxOutputTokens: 1_000_000 },
    modelKey: MODEL_KEY,
    providerCode: PROVIDER,
    providerModelId: PROVIDER_MODEL_ID,
  });
  const budgets = new InMemoryBudgetReservationRepository();
  budgets.setLimit(TENANT_ID, 'CNY', limitCents);
  return {
    budgets,
    router: new ModelRouter(
      [{ adapter, modelKey: MODEL_KEY, provider: PROVIDER, providerModelId: PROVIDER_MODEL_ID }],
      new InMemoryModelRateCardRepository([rateCard()]),
      budgets,
    ),
  };
}

function rateCard(overrides: Partial<ModelRateCard> = {}): ModelRateCard {
  return {
    capabilities: {
      jsonMode: true,
      jsonSchema: true,
      maxOutputTokens: 1_000_000,
      streaming: true,
      toolCalling: true,
    },
    currency: 'CNY',
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveTo: null,
    id: RATE_CARD_ID,
    inputRateMicros: 1_000_000n,
    modelKey: MODEL_KEY,
    outputRateMicros: 2_000_000n,
    provider: PROVIDER,
    providerModelId: PROVIDER_MODEL_ID,
    ...overrides,
  };
}

function estimateRequest(
  overrides: Partial<Parameters<ModelRouter['estimate']>[0]> = {},
): Parameters<ModelRouter['estimate']>[0] {
  return {
    at: AT,
    estimatedInputTokens: 1_000_000,
    maxOutputTokens: 500_000,
    modelKey: MODEL_KEY,
    requestId: 'request-1',
    tenantId: TENANT_ID,
    ...overrides,
  };
}

function usage(overrides: Partial<ModelUsage> = {}): ModelUsage {
  return {
    durationMs: 10,
    inputTokens: 1_000_000,
    modelKey: MODEL_KEY,
    outputTokens: 500_000,
    providerCode: PROVIDER,
    providerModelId: PROVIDER_MODEL_ID,
    providerRequestId: 'provider-request-1',
    totalTokens: 1_500_000,
    ...overrides,
  };
}
