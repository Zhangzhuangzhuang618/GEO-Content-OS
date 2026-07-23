import { DomainEventEnvelopeSchema, type DomainEventEnvelope } from '@geo-content-os/contracts';

export interface EventReceiptKey {
  readonly consumerName: string;
  readonly eventId: string;
  readonly businessKey: string;
}

export type IdempotentConsumeResult<TResult> =
  { readonly outcome: 'processed'; readonly value: TResult } | { readonly outcome: 'duplicate' };

/**
 * Implementations must check/record the receipt and execute `operation` in one
 * database transaction. Domain modules own the receipt table or unique business
 * key so this framework does not create a second source of truth.
 */
export interface EventReceiptStore {
  executeOnce<TResult>(
    key: EventReceiptKey,
    operation: () => Promise<TResult>,
  ): Promise<IdempotentConsumeResult<TResult>>;
}

export class IdempotentEventConsumer {
  public constructor(
    private readonly consumerName: string,
    private readonly receiptStore: EventReceiptStore,
  ) {
    if (consumerName.trim().length === 0) {
      throw new Error('consumerName must not be empty');
    }
  }

  public async consume<TResult>(
    rawEvent: unknown,
    businessKey: string,
    handler: (event: DomainEventEnvelope) => Promise<TResult>,
  ): Promise<IdempotentConsumeResult<TResult>> {
    if (businessKey.trim().length === 0) {
      throw new Error('businessKey must not be empty');
    }

    const event = DomainEventEnvelopeSchema.parse(rawEvent);

    return this.receiptStore.executeOnce(
      {
        businessKey,
        consumerName: this.consumerName,
        eventId: event.event_id,
      },
      () => handler(event),
    );
  }
}
