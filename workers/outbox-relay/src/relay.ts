import type { OutboxRelayStore } from './store.js';
import type { EventPublisher, RelayRunResult } from './types.js';

export interface OutboxRelayOptions {
  readonly batchSize: number;
  readonly leaseDurationMs: number;
  readonly maximumAttempts: number;
  readonly retryDelayMs: number;
}

export class OutboxRelay {
  public constructor(
    private readonly owner: string,
    private readonly store: OutboxRelayStore,
    private readonly publisher: EventPublisher,
    private readonly options: OutboxRelayOptions,
  ) {}

  public async runOnce(): Promise<RelayRunResult> {
    const recoveredLeases = await this.store.releaseExpiredLeases(this.options.leaseDurationMs);
    const events = await this.store.claimBatch(this.owner, this.options.batchSize);
    let published = 0;
    let retried = 0;
    let failed = 0;
    let leaseLost = 0;

    for (const event of events) {
      try {
        await this.publisher.publish(event);
        if (await this.store.markPublished(event.id, this.owner)) {
          published += 1;
        } else {
          leaseLost += 1;
        }
      } catch (error) {
        const disposition = await this.store.markPublishFailure(
          event.id,
          this.owner,
          error,
          this.options.maximumAttempts,
          this.options.retryDelayMs,
        );

        if (disposition === 'failed') {
          failed += 1;
        } else if (disposition === 'retry') {
          retried += 1;
        } else {
          leaseLost += 1;
        }
      }
    }

    return {
      claimed: events.length,
      failed,
      leaseLost,
      published,
      recoveredLeases,
      retried,
    };
  }
}
