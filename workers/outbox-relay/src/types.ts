import type {
  AggregateType,
  DomainEventEnvelope,
  EventType,
  OutboxStatus,
} from '@geo-content-os/contracts';

export interface ClaimedOutboxEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly eventType: EventType;
  readonly aggregateType: AggregateType;
  readonly aggregateId: string;
  readonly payload: DomainEventEnvelope;
  readonly status: OutboxStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt: Date;
  readonly lockedAt: Date;
  readonly lockedBy: string;
  readonly lastError: string | null;
  readonly publishedAt: Date | null;
  readonly createdAt: Date;
}

export interface EventPublisher {
  publish(event: ClaimedOutboxEvent): Promise<void>;
  close(): Promise<void>;
}

export interface RelayRunResult {
  readonly claimed: number;
  readonly published: number;
  readonly retried: number;
  readonly failed: number;
  readonly leaseLost: number;
  readonly recoveredLeases: number;
}
