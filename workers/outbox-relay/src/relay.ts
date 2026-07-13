import {
  createNullLogger,
  resolveRequestId,
  runWithTelemetryContext,
  type StructuredLogger,
  type TelemetryContextFields,
} from '@geo-content-os/observability';

import type { OutboxRelayStore } from './store.js';
import type { ClaimedOutboxEvent, EventPublisher, RelayRunResult } from './types.js';

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
    private readonly logger: StructuredLogger = createNullLogger(),
  ) {}

  public async runOnce(): Promise<RelayRunResult> {
    const recoveredLeases = await this.store.releaseExpiredLeases(this.options.leaseDurationMs);
    const events = await this.store.claimBatch(this.owner, this.options.batchSize);
    let published = 0;
    let retried = 0;
    let failed = 0;
    let leaseLost = 0;

    for (const event of events) {
      await runWithTelemetryContext(correlationFields(event), async () => {
        try {
          await this.publisher.publish(event);
          if (await this.store.markPublished(event.id, this.owner)) {
            published += 1;
            this.logger.info('Outbox event published', {
              event: 'queue.outbox.published',
              event_type: event.eventType,
              queue_attempt: event.attemptCount,
            });
          } else {
            leaseLost += 1;
            this.logger.warn('Outbox lease lost after publish', {
              event: 'queue.outbox.lease_lost',
              event_type: event.eventType,
            });
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
          this.logger.error('Outbox event publish failed', error, {
            disposition,
            event: 'queue.outbox.publish_failed',
            event_type: event.eventType,
            queue_attempt: event.attemptCount,
          });
        }
      });
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

function correlationFields(event: ClaimedOutboxEvent): TelemetryContextFields {
  const data =
    typeof event.payload.data === 'object' &&
    event.payload.data !== null &&
    !Array.isArray(event.payload.data)
      ? event.payload.data
      : {};
  const runId = readString(data, 'run_id');
  return {
    jobId: event.id,
    requestId: resolveRequestId(readString(data, 'request_id') ?? event.id),
    ...(runId ? { runId } : {}),
    tenantId: event.tenantId,
  };
}

function readString(value: object, key: string): string | undefined {
  const item = (value as Readonly<Record<string, unknown>>)[key];
  return typeof item === 'string' && item.length > 0 ? item : undefined;
}
