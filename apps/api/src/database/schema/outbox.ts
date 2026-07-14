import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
  unique,
  varchar,
} from 'drizzle-orm/pg-core';

import { tenants } from './identity.js';

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    eventType: varchar('event_type', { length: 80 }).notNull(),
    aggregateType: varchar('aggregate_type', { length: 64 }).notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    payloadJson: jsonb('payload_json').notNull(),
    status: varchar({ length: 16 }).notNull().default('pending'),
    attemptCount: smallint('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: varchar('locked_by', { length: 120 }),
    lastError: text('last_error'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('outbox_events_id_tenant_uq').on(table.id, table.tenantId),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: 'outbox_events_tenant_fk',
    }).onDelete('restrict'),
    check(
      'outbox_events_status_check',
      sql`${table.status} IN ('pending', 'processing', 'published', 'failed')`,
    ),
    check('outbox_events_attempt_count_check', sql`${table.attemptCount} >= 0`),
    check(
      'outbox_events_processing_lease_check',
      sql`(${table.status} = 'processing' AND ${table.lockedAt} IS NOT NULL AND ${table.lockedBy} IS NOT NULL)
        OR (${table.status} <> 'processing' AND ${table.lockedAt} IS NULL AND ${table.lockedBy} IS NULL)`,
    ),
    index('outbox_events_due_idx')
      .on(table.nextAttemptAt, table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    index('outbox_events_expired_lease_idx')
      .on(table.lockedAt, table.createdAt)
      .where(sql`${table.status} = 'processing'`),
    index('outbox_events_tenant_created_idx').on(table.tenantId, table.createdAt),
    index('outbox_events_aggregate_idx').on(
      table.tenantId,
      table.aggregateType,
      table.aggregateId,
      table.createdAt,
    ),
  ],
);

export type OutboxEventRecord = typeof outboxEvents.$inferSelect;
