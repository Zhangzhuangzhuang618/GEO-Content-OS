import type {
  AggregateType,
  DomainEventEnvelope,
  EventType,
  OutboxStatus,
} from '@geo-content-os/contracts';
import type postgres from 'postgres';

export type OutboxSql = postgres.Sql | postgres.TransactionSql;

export interface EnqueueOutboxEventInput {
  readonly tenantId: string;
  readonly eventType: EventType;
  readonly aggregateType: AggregateType;
  readonly aggregateId: string;
  readonly data: DomainEventEnvelope['data'];
  readonly occurredAt?: Date | string;
}

export interface OutboxEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly eventType: EventType;
  readonly aggregateType: AggregateType;
  readonly aggregateId: string;
  readonly payload: DomainEventEnvelope;
  readonly status: OutboxStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt: Date;
  readonly lockedAt: Date | null;
  readonly lockedBy: string | null;
  readonly lastError: string | null;
  readonly publishedAt: Date | null;
  readonly createdAt: Date;
}
